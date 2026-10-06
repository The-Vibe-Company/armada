import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryKey,
  type Fleet,
  freshRuntimeState,
  machinePaths,
  parseConfig,
  RuntimeError,
  type RuntimeName,
  readWatchState,
  recordClaim,
  updateWatchState,
  watchFiles,
} from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import { observeRuntimes } from "../src/runtime.ts";
import { claimRef, guarded, type LaunchSpec, runtimeFor } from "../src/runtimes/adapter.ts";

const config = parseConfig(DEMO_TOML);
const canary = "armada_launch_CANARY_secret";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const json = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

async function fixture(runtime: RuntimeName = "conductor") {
  const home = await mkdtemp(join(tmpdir(), "armada-adapter-"));
  homes.push(home);
  const store = memoryFleet();
  const clock = fakeClock(NOW);
  const branch = "feature/demo-7";
  const handle =
    runtime === "herdr" ? JSON.stringify({ workspace: "w8", pane: "w8:p9", agent: "demo-7" }) : "ws-1/ses-1";
  await recordClaim(
    store,
    config.project.slug,
    { ticket: "DEMO-7", runtime, handle, branch, phase: "implementing", resuming: false, profile: null },
    NOW,
  );
  const h = await store.getRuntimeHandle(config.project.slug, "DEMO-7");
  if (!h) throw new Error("missing fixture");
  let state = "working",
    archived = false,
    failure = 0,
    timedOut = false,
    mismatch = false,
    missingAcknowledgement = false;
  const calls: { command: string; args: string[]; input?: string; timeoutMs?: number }[] = [];
  const output: string[] = [];
  let beforeRead: (() => Promise<void>) | null = null;
  let beforeReadAfter = 1;
  const api = fakeArmada({ store, clock, keys: { armada_key_CANARY_test: "test" } });
  const io: Io = {
    cwd: "/work/widgets",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_CANARY_test",
      LINEAR_API_KEY: "synthetic-runtime-key",
    },
    readFile: async (p) => (p === "/work/widgets/armada.toml" ? DEMO_TOML : null),
    ghToken: () => null,
    now: clock.now,
    sleep: clock.sleep,
    fetch: api.fetch,
    stdout: (t) => output.push(t),
    stderr: (t) => output.push(t),
    exec: async (command, args, options) => {
      calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs });
      if (command === "git")
        return { code: 0, stdout: args[0] === "branch" ? branch : "/work/widgets/.git", stderr: "" };
      if (command === "herdr") {
        if (timedOut && ["prompt", "send-keys", "remove", "close"].includes(args[1] ?? ""))
          return { code: 1, stdout: canary, stderr: canary, timedOut: true };
        if (args[0] === "agent" && args[1] === "get" && beforeRead && --beforeReadAfter === 0) {
          const hook = beforeRead;
          beforeRead = null;
          await hook();
        }
        return json({
          result:
            args[0] === "workspace"
              ? {
                  workspace: {
                    workspace_id: "w8",
                    worktree: {
                      repo_root: "/work/widgets",
                      checkout_path: "/work/trees/demo-7",
                      is_linked_worktree: true,
                    },
                  },
                }
              : { agent: { name: "demo-7", pane_id: "w8:p9", workspace_id: "w8", agent_status: state } },
        });
      }
      const a = args.slice(1);
      if (failure) return { code: failure, stdout: canary, stderr: canary };
      if (timedOut) return { code: 1, stdout: canary, stderr: canary, timedOut: true };
      if (a[0] === "session" && a[1] === "status") {
        if (beforeRead) {
          const hook = beforeRead;
          beforeRead = null;
          await hook();
        }
        return json({
          workspaceId: mismatch ? "other-ws" : "ws-1",
          sessionId: "ses-1",
          status: state,
          updatedAt: NOW.toISOString(),
        });
      }
      if (a[0] === "workspace" && a[1] === "status")
        return json({ workspaceId: "ws-1", status: archived ? "archived" : "ready", updatedAt: NOW.toISOString() });
      if (a[1] === "cancel") {
        state = "idle";
        return json({ status: "idle", canceledQueuedMessages: 0 });
      }
      if (a[1] === "archive") {
        archived = true;
        return json({ status: "archived" });
      }
      if (a[0] === "message") return json({ messageId: "msg-1", state: state === "working" ? "queued" : "sent" });
      if (a[1] === "create")
        return json({
          ...(a[0] === "session" ? { id: "ses-new" } : { workspaceId: "ws-new", sessionId: "ses-new" }),
          deepLink: "conductor://ws-new",
          ...(!missingAcknowledgement ? { initialMessage: { messageId: "msg-first", state: "queued" } } : {}),
        });
      if (a[0] === "--version") return { code: 0, stdout: "0.90.1", stderr: "" };
      if (a[0] === "auth") return json({ signedIn: true });
      if (a[0] === "model")
        return json({
          agents: [{ agent: "codex", models: ["synthetic-model"], efforts: ["high"], fastModeModels: [] }],
        });
      if (a[1] === "message")
        return json({
          data: [
            {
              id: "evt-1",
              receivedAt: NOW.toISOString(),
              content: {
                rawPayload: {
                  event: {
                    type: "item.completed",
                    item: { type: "agentMessage", phase: "final_answer", text: canary },
                  },
                },
              },
            },
          ],
          hasMore: false,
        });
      throw new Error("unexpected fake command");
    },
  };
  const fleet = {
    runtimeHandle: (ticket: string) => store.getRuntimeHandle(config.project.slug, ticket),
    runtimeHandles: () => store.openRuntimeHandles(config.project.slug),
    pendingLaunches: () => store.pendingLaunches(config.project.slug, new Date(0)),
    observeRuntime: (input: Parameters<Fleet["observeRuntime"]>[0]) =>
      store.observeRuntime({ ...input, project: config.project.slug, at: clock.now() }),
    stopRuntime: (input: Parameters<Fleet["stopRuntime"]>[0]) =>
      store.stopRuntime({ ...input, project: config.project.slug, at: clock.now() }),
  } as Fleet;
  return {
    io,
    store,
    clock,
    calls,
    output,
    fleet,
    h,
    target: claimRef(h),
    adapter: runtimeFor(io, config, runtime),
    set: (v: {
      state?: string;
      archived?: boolean;
      failure?: number;
      timedOut?: boolean;
      mismatch?: boolean;
      beforeRead?: () => Promise<void>;
      beforeReadAfter?: number;
      missingAcknowledgement?: boolean;
    }) => {
      state = v.state ?? state;
      archived = v.archived ?? archived;
      failure = v.failure ?? failure;
      timedOut = v.timedOut ?? timedOut;
      mismatch = v.mismatch ?? mismatch;
      beforeRead = v.beforeRead ?? beforeRead;
      beforeReadAfter = v.beforeReadAfter ?? beforeReadAfter;
      missingAcknowledgement = v.missingAcknowledgement ?? missingAcknowledgement;
    },
  };
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    throw new Error("expected refusal");
  } catch (e) {
    if (!(e instanceof RuntimeError)) throw e;
    return e.code;
  }
};

test.each(["conductor", "herdr"] as const)(
  "%s adapter reads without mutation, validates handles, and guards message delivery",
  async (runtime) => {
    const f = await fixture(runtime);
    expect((await f.adapter.observe(f.target)).state).toBe("working");
    expect(f.calls.some((c) => ["create", "prompt", "run", "archive", "cancel"].includes(c.args[2] ?? ""))).toBe(false);
    expect(() =>
      f.adapter.parse(runtime === "conductor" ? "--bad/session" : '{"workspace":"--bad","pane":"p","agent":"a"}'),
    ).toThrow(RuntimeError);
    const key = deliveryKey({
      project: "widgets",
      ticket: "DEMO-7",
      claimedAt: f.target.claimedAt,
      launchId: null,
      item: 7,
      kind: "answer",
      text: canary,
    });
    expect(key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await codeOf(f.adapter.deliver(f.target, { text: canary, key, kind: "answer" }))).toBe("stale");
    await guarded(f.fleet, f.target, "active", () =>
      f.adapter.deliver(f.target, { text: canary, key, kind: "answer" }),
    );
    const write = f.calls.find(
      (c) => c.command === runtime && c.args.includes(runtime === "herdr" ? "prompt" : "--message-file"),
    );
    expect(write).toBeDefined();
    if (runtime === "conductor") {
      expect(write?.input).toBe(canary);
      expect(f.calls.flatMap((c) => c.args)).not.toContain(canary);
      expect(write?.args).toContain(key);
    } else expect(write?.args).toContain(canary);
    expect(f.output.join("")).not.toContain(canary);
    await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
    await recordClaim(
      f.store,
      config.project.slug,
      {
        ticket: "DEMO-7",
        runtime,
        handle: f.h.handle,
        branch: f.h.branch,
        phase: "implementing",
        resuming: false,
        profile: null,
      },
      new Date(NOW.getTime() + 1000),
    );
    const count = f.calls.length;
    expect(
      await codeOf(
        guarded(f.fleet, f.target, "active", () => f.adapter.deliver(f.target, { text: canary, key, kind: "answer" })),
      ),
    ).toBe("stale");
    expect(f.calls.length).toBe(count);
  },
);

test("Conductor preflight, launch, transcript and failures keep secret text off argv and output", async () => {
  const f = await fixture();
  const spec: LaunchSpec = {
    ticket: "DEMO-7",
    title: "Synthetic worker",
    repository: "acme/widgets",
    base: "main",
    branch: "feature/demo-7",
    from: { kind: "base" },
    profile: { name: "test", agent: "codex", model: "synthetic-model", effort: "high", fastMode: false },
    prompt: canary,
    env: { ARMADA_TICKET: "DEMO-7" },
    blankSecrets: [],
  };
  expect(
    (await f.adapter.preflight({ profile: spec.profile, repository: spec.repository })).every((c) => c.level === "ok"),
  ).toBe(true);
  expect(f.calls.some((c) => c.args.includes("whoami"))).toBe(true);
  expect(f.calls.some((c) => c.args.includes("auth") && c.args.includes("status"))).toBe(false);
  expect((await f.adapter.launch(spec)).handle).toBe("ws-new/ses-new");
  expect((await f.adapter.launch({ ...spec, from: { kind: "branch", head: "a".repeat(40) } })).handle).toBe(
    "ws-new/ses-new",
  );
  const launches = f.calls.filter((c) => c.args.includes("--repo-url"));
  expect(launches[0]?.input).toBe(canary);
  expect(launches[0]?.args).toContain("main");
  expect(launches[1]?.args).toContain(spec.branch);
  expect(f.calls.flatMap((c) => c.args)).not.toContain(canary);
  await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
  const old = await f.fleet.runtimeHandle("DEMO-7");
  if (!old) throw new Error("missing claim");
  const previous = claimRef(old);
  expect(
    (
      await guarded(f.fleet, previous, "ended", () =>
        f.adapter.launch({ ...spec, from: { kind: "in-place", previous } }),
      )
    ).handle,
  ).toBe("ws-1/ses-new");
  const createSession = f.calls.find((c) => c.args[1] === "session" && c.args[2] === "create");
  expect(createSession?.input).toBe(canary);
  expect(createSession?.args).toContain("ws-1");
  expect((await f.adapter.peek(f.target, { actions: 3, cursor: null })).lastReply).toEqual({
    text: "[redacted]",
    at: NOW.toISOString(),
  });
  f.set({ missingAcknowledgement: true });
  try {
    await f.adapter.launch(spec);
    throw new Error("expected missing acknowledgement refusal");
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    expect(error.code).toBe("unknown-outcome");
    expect(error.retryable).toBe(false);
    expect(error.next).toContain("ws-new/ses-new");
  }
  for (const [exit, code] of [
    [3, "auth"],
    [4, "unavailable"],
    [2, "invalid"],
    [1, "unavailable"],
  ] as const) {
    f.set({ failure: exit });
    expect(await codeOf(f.adapter.observe(f.target))).toBe(code);
  }
  f.set({ failure: 0, timedOut: true });
  expect(await codeOf(f.adapter.launch(spec))).toBe("unknown-outcome");
  expect(f.output.join("")).not.toContain(canary);
});

test("Conductor refuses active archive, verifies workspace ownership, waits boundedly and stops only ended generations", async () => {
  const f = await fixture();
  const options = { reason: "released" as const, whenWorking: "wait" as const, waitMs: 30_000 };
  expect(await codeOf(guarded(f.fleet, f.target, "active", () => f.adapter.archive(f.target, options)))).toBe("busy");
  expect(f.calls).toHaveLength(0);
  expect(await run(["stop", "DEMO-7"], f.io)).toBe(1);
  expect(f.output.join("")).toContain("release first");
  f.set({ mismatch: true });
  expect(
    await codeOf(
      guarded(f.fleet, f.target, "active", () =>
        f.adapter.deliver(f.target, { text: "resume", key: "msg-key", kind: "answer" }),
      ),
    ),
  ).toBe("mismatch");
  expect(f.calls.some((c) => c.args.includes("create"))).toBe(false);
  f.set({ mismatch: false });
  await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
  const h = await f.fleet.runtimeHandle("DEMO-7");
  if (!h) throw new Error("missing claim");
  const ended = claimRef(h);
  expect((await guarded(f.fleet, ended, "ended", () => f.adapter.archive(ended, options))).archived).toBe(true);
  expect(f.clock.now().getTime() - NOW.getTime()).toBe(30_000);
  expect(f.calls.some((c) => c.args.includes("cancel"))).toBe(true);
  expect((await guarded(f.fleet, ended, "ended", () => f.adapter.archive(ended, options))).alreadyGone).toBe(true);
});

test("a replacement during Conductor provenance checks prevents cancel and archive writes", async () => {
  for (const operation of ["deliver", "cancel", "archive"] as const) {
    const f = await fixture();
    if (operation === "archive") await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
    const h = await f.fleet.runtimeHandle("DEMO-7");
    if (!h) throw new Error("missing claim");
    const expected = claimRef(h);
    f.set({
      beforeRead: async () => {
        await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
        await recordClaim(
          f.store,
          config.project.slug,
          {
            ticket: "DEMO-7",
            runtime: "conductor",
            handle: "ws-new/ses-new",
            branch: null,
            phase: "implementing",
            resuming: false,
            profile: null,
          },
          new Date(NOW.getTime() + 1000),
        );
      },
    });
    const act = (): Promise<unknown> =>
      operation === "deliver"
        ? f.adapter.deliver(expected, { text: "hello", kind: "note", key: "msg-key" })
        : operation === "cancel"
          ? f.adapter.cancel(expected, { waitMs: 1000 })
          : f.adapter.archive(expected, { reason: "released", whenWorking: "cancel", waitMs: 0 });
    expect(await codeOf(guarded(f.fleet, expected, operation === "archive" ? "ended" : "active", act))).toBe("stale");
    expect(
      f.calls.some((c) => c.args.includes("create") || c.args.includes("cancel") || c.args.includes("archive")),
    ).toBe(false);
  }
});

test("Conductor observations are throttled across processes, retain failed reads and surface stored state in inbox", async () => {
  const f = await fixture();
  const paths = machinePaths(f.io.env);
  if (!paths) throw new Error("missing test machine paths");
  await updateWatchState(paths, config.project.slug, { readAt: NOW.toISOString() });
  const oldWatch = await readWatchState(paths, config.project.slug);
  f.clock.advance(8 * 60_000);
  f.set({ state: "error" });
  await observeRuntimes(f.io, f.fleet, config);
  // A concurrent ordinary watch may commit a snapshot read before the reservation.
  await writeFile(watchFiles(paths, config.project.slug).state, JSON.stringify({ ...oldWatch, stopped: "done" }));
  await observeRuntimes({ ...f.io }, f.fleet, config);
  expect(f.calls.filter((c) => c.args.includes("status")).length).toBe(2);
  expect((await f.fleet.runtimeHandle("DEMO-7"))?.runtimeState?.state).toBe("failed");
  expect(
    freshRuntimeState(
      { state: "working", at: NOW.toISOString(), since: new Date(NOW.getTime() - 1000).toISOString() },
      NOW,
      15,
      NOW.toISOString(),
    ),
  ).toBe("working");
  f.clock.advance(60_000);
  f.set({ failure: 4 });
  await observeRuntimes(f.io, f.fleet, config);
  expect((await f.fleet.runtimeHandle("DEMO-7"))?.runtimeState?.state).toBe("failed");
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.output.at(-1) ?? "{}").runtimes).toContainEqual({
    ticket: "DEMO-7",
    runtime: "conductor",
    state: "failed",
  });
  f.clock.advance(16 * 60_000);
  expect(await run(["inbox", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.output.at(-1) ?? "{}").runtimes[0].state).toBe("unknown");
});

test("herdr rechecks the generation after internal state reads and before native writes", async () => {
  for (const operation of ["deliver", "cancel", "archive"] as const) {
    const f = await fixture("herdr");
    if (operation === "archive") await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
    const h = await f.fleet.runtimeHandle("DEMO-7");
    if (!h) throw new Error("missing claim");
    const expected = claimRef(h);
    f.set({
      state: operation === "archive" ? "idle" : "working",
      beforeReadAfter: operation === "deliver" ? 1 : 2,
      beforeRead: async () => {
        await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
        await recordClaim(
          f.store,
          config.project.slug,
          {
            ticket: "DEMO-7",
            runtime: "herdr",
            handle: f.h.handle,
            branch: f.h.branch,
            phase: "implementing",
            resuming: false,
            profile: null,
          },
          new Date(NOW.getTime() + 1000),
        );
      },
    });
    const act = (): Promise<unknown> =>
      operation === "deliver"
        ? f.adapter.deliver(expected, { text: "hello", kind: "note", key: "msg" })
        : operation === "cancel"
          ? f.adapter.cancel(expected, { waitMs: 1000 })
          : f.adapter.archive(expected, { reason: "relaunched", whenWorking: "cancel", waitMs: 0 });
    expect(await codeOf(guarded(f.fleet, expected, operation === "archive" ? "ended" : "active", act))).toBe("stale");
    expect(
      f.calls.filter(
        (c) => c.command === "herdr" && ["prompt", "run", "send-keys", "close", "remove"].includes(c.args[1] ?? ""),
      ),
    ).toEqual([]);
  }
});

test("herdr cancellation and archive timeouts are uncertain mutations, never retryable outages", async () => {
  for (const operation of ["cancel", "archive"] as const) {
    const f = await fixture("herdr");
    if (operation === "archive") await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
    const h = await f.fleet.runtimeHandle("DEMO-7");
    if (!h) throw new Error("missing claim");
    const expected = claimRef(h);
    f.set({ timedOut: true });
    try {
      await guarded<unknown>(f.fleet, expected, operation === "archive" ? "ended" : "active", () =>
        operation === "cancel"
          ? f.adapter.cancel(expected, { waitMs: 1000 })
          : f.adapter.archive(expected, { reason: "relaunched", whenWorking: "cancel", waitMs: 0 }),
      );
      throw new Error("expected timeout refusal");
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      expect(error.code).toBe("unknown-outcome");
      expect(error.retryable).toBe(false);
      expect(error.message).not.toContain(canary);
    }
  }
});

test("Claude Code refuses every adapter operation with the manual guide and executes nothing", async () => {
  const f = await fixture("claude-code");
  expect(Object.values(f.adapter.can).every((v) => !v)).toBe(true);
  const unused = {} as LaunchSpec;
  for (const act of [
    () => f.adapter.preflight({ profile: unused.profile, repository: "acme/widgets" }),
    () => f.adapter.launch(unused),
    () => f.adapter.deliver(f.target, { text: "x", kind: "note", key: "msg" }),
    () => f.adapter.observe(f.target),
    () => f.adapter.peek(f.target, { actions: 1, cursor: null }),
    () => f.adapter.cancel(f.target, { waitMs: 1 }),
    () => f.adapter.archive(f.target, { reason: "released", whenWorking: "refuse", waitMs: 0 }),
  ]) {
    expect(await codeOf(act())).toBe("unsupported");
  }
  expect(() => f.adapter.parse("anything")).toThrow("armada-runtime-claude-code");
  expect(await run(["stop", "DEMO-7"], f.io)).toBe(1);
  expect(f.output.join("")).toContain("armada-runtime-claude-code");
  expect(f.calls).toEqual([]);
});

test("Conductor observes only stale heartbeats and readings, using bounded reads; archives end the exact claim", async () => {
  const f = await fixture();
  await observeRuntimes(f.io, f.fleet, config);
  expect(f.calls).toEqual([]);
  f.clock.advance(8 * 60_000);
  await observeRuntimes(f.io, f.fleet, config);
  expect((await f.fleet.runtimeHandle("DEMO-7"))?.runtimeState?.state).toBe("working");
  expect(f.calls.every((c) => c.timeoutMs === 5000)).toBe(true);
  const count = f.calls.length;
  f.clock.advance(4 * 60_000);
  await observeRuntimes({ ...f.io }, f.fleet, config);
  expect(f.calls.length).toBe(count);
  f.clock.advance(60_000);
  f.set({ archived: true });
  await observeRuntimes(f.io, f.fleet, config);
  expect(await f.fleet.runtimeHandles()).toEqual([]);
  expect((await f.fleet.runtimeHandle("DEMO-7"))?.releasedAt).toBe(f.clock.now().toISOString());
});

test("missing or unsigned Conductor retains the current claim and prints no error", async () => {
  const f = await fixture();
  f.clock.advance(8 * 60_000);
  f.set({ failure: 3 });
  await observeRuntimes(f.io, f.fleet, config);
  expect((await f.fleet.runtimeHandle("DEMO-7"))?.runtimeState).toBeNull();
  expect(f.output).toEqual([]);
  f.clock.advance(60_000);
  await observeRuntimes(
    {
      ...f.io,
      exec: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
    f.fleet,
    config,
  );
  expect((await f.fleet.runtimeHandles()).length).toBe(1);
  expect(f.output).toEqual([]);
});

test("an archive observation cannot close a replacement claim", async () => {
  const f = await fixture();
  f.clock.advance(8 * 60_000);
  const original = f.fleet.stopRuntime;
  f.fleet.stopRuntime = async (input) => {
    await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", f.clock.now());
    f.clock.advance(1000);
    await recordClaim(
      f.store,
      config.project.slug,
      {
        ticket: "DEMO-7",
        runtime: "conductor",
        handle: "ws-new/ses-new",
        branch: "feature/demo-7",
        phase: "implementing",
        resuming: false,
        profile: null,
      },
      f.clock.now(),
    );
    return original(input);
  };
  f.set({ archived: true });
  await observeRuntimes(f.io, f.fleet, config);
  expect(await f.fleet.runtimeHandles()).toMatchObject([{ handle: "ws-new/ses-new", releasedAt: null }]);
});

test.each(["provenance", "wait"])("ended archive refuses new workspace sharing during %s", async (when) => {
  const f = await fixture();
  await f.store.releaseRuntimeHandle(config.project.slug, "DEMO-7", NOW);
  const h = await f.fleet.runtimeHandle("DEMO-7");
  if (!h) throw new Error("missing ended fixture claim");
  const ended = claimRef(h);
  const share = async () => {
    await f.store.saveRuntimeHandle({
      project: config.project.slug,
      ticket: "DEMO-8",
      runtime: "Conductor",
      handle: "ws-1/ses-other",
      branch: "feature/demo-8",
      at: f.clock.now(),
    });
    f.set({ state: "idle" });
  };
  if (when === "provenance") f.set({ state: "idle", beforeRead: share });
  else
    f.io.sleep = async (ms) => {
      await f.clock.sleep(ms);
      await share();
    };
  expect(
    await codeOf(
      guarded(f.fleet, ended, "ended", () =>
        f.adapter.archive(ended, { reason: "merged", whenWorking: "wait", waitMs: 600_000 }),
      ),
    ),
  ).toBe("busy");
  expect(f.calls.some((call) => call.args.includes("archive") || call.args.includes("cancel"))).toBe(false);
});
