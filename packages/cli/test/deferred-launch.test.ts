import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, machinePaths, parseConfig, resolveCredentials } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, fakeClock, issue, NOW, recordedFetch } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import { renderStatus } from "../src/render.ts";
import { firingDeferredFleet } from "../src/watch.ts";
import { liveFleet } from "../src/worker.ts";

const config = parseConfig(
  `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "synthetic-model"\neffort = "high"\n`,
);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("launch --when-unblocked and --after store server-checked requests, print blockers and show parked state in status", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-deferred-"));
  dirs.push(home);
  const program = {
    rootId: "DEMO-1",
    issues: [
      issue("DEMO-1", { parentId: null }),
      issue("DEMO-7", { parentId: "DEMO-1" }),
      issue("DEMO-9", { parentId: "DEMO-1", blockedBy: [{ id: "DEMO-7", statusType: "unstarted" }] }),
    ],
    comments: [],
    warnings: [],
    fetchedAt: NOW.toISOString(),
  };
  const facts = {
    config,
    snapshot: {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [],
      parkedLabel: config.tracker.parkedLabel,
      flight: { program, forge: null, after: program.fetchedAt },
    },
  };
  const store = memoryFleet();
  const api = fakeArmada({
    keys: { armada_key_TEST: "test" },
    facts,
    store,
    vault: { linear: { apiKey: "lin_test", scope: "own" }, now: () => NOW },
  });
  const lines: string[] = [];
  const io: Io = {
    cwd: "/work",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_TEST",
      ARMADA_COORDINATOR: "front",
    },
    readFile: async () =>
      `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "synthetic-model"\neffort = "high"\n`,
    fetch: api.fetch,
    stdout: (t) => lines.push(t),
    stderr: (t) => lines.push(t),
    ghToken: () => null,
    now: () => NOW,
  };
  expect(await run(["launch", "demo-9", "--when-unblocked", "--profile", "backend", "--after", "demo-7"], io)).toBe(0);
  expect(lines.join("")).toContain("DEMO-9 will launch once DEMO-7 is done");
  expect(api.calls.some((c) => c.path === "launch-tokens")).toBe(false);
  expect(store.items).toMatchObject([{ ticket: "DEMO-9", requestDeferred: true, coordinator: "front" }]);
  const item = store.items[0];
  if (!item) throw new Error("missing request");
  await api.store.resolveInboxItem({ project: "widgets", id: item.id, resolution: "declined", at: NOW });
  lines.length = 0;
  expect(await run(["launch", "demo-9", "--after", "demo-7", "--json"], io)).toBe(0);
  expect(JSON.parse(lines.join(""))).toMatchObject({ ticket: "DEMO-9", blockers: ["DEMO-7"], owned: true });
  program.issues[2]?.labels.push(config.tracker.parkedLabel);
  const deferred = await api.store.openInboxItems({ project: "widgets", recipient: "coordinator" });
  const { deferredLaunchState } = await import("../../core/src/deferred.ts");
  const { buildModel } = await import("../../core/src/model.ts");
  const report = buildStatus({
    config,
    program,
    forge: null,
    now: NOW,
    launchWhenUnblocked: deferred.map((i) =>
      deferredLaunchState(i, buildModel(program.issues, program.rootId), config.tracker.parkedLabel, false),
    ),
  });
  expect(renderStatus(report)).toContain("Launch when unblocked (1)\n  DEMO-9  parked");
  lines.length = 0;
  program.issues[2]?.labels.pop();
  io.readStdin = async () => "Keep queued context";
  expect(await run(["launch", "demo-9", "--when-unblocked", "--runtime", "conductor", "--notes", "-"], io)).toBe(0);
  expect(lines.join("")).toContain("renewed until");
  expect((await api.store.openInboxItems({ project: "widgets", recipient: "coordinator" }))[0]?.request).toMatchObject({
    runtime: "conductor",
    notes: "Keep queued context",
    pinned: false,
    profile: null,
  });
  for (const empty of [["--after="], ["--after", ""]]) {
    lines.length = 0;
    expect(await run(["launch", "demo-9", ...empty], io)).not.toBe(0);
    expect(lines.join("")).toContain("after must be a ticket id");
  }
  expect(api.calls.some((c) => c.path === "launch-tokens")).toBe(false);
});

const WATCH_TOML = `${DEMO_TOML}
[policy]
max_workers = 2
[conductor]
default_profile = "backend"
[conductor.profiles.backend]
agent = "codex"
model = "synthetic-model"
effort = "high"
[conductor.profiles.guided]
runtime = "claude-code"
agent = "claude"
model = "synthetic-model"
effort = "high"
`;

async function watchingLaunches() {
  const home = await mkdtemp(join(tmpdir(), "armada-deferred-watch-"));
  dirs.push(home);
  const clock = fakeClock();
  const config = parseConfig(WATCH_TOML);
  const program = {
    rootId: "DEMO-1",
    issues: [
      issue("DEMO-1"),
      ...[13, 14, 15, 16].map((n) =>
        issue(`DEMO-${n}`, {
          parentId: "DEMO-1",
          labels: [config.tracker.readyLabel],
        }),
      ),
    ],
    comments: [],
    warnings: [],
    fetchedAt: clock.now().toISOString(),
  };
  const store = memoryFleet();
  const api = fakeArmada({
    keys: { armada_key_TEST: "test" },
    store,
    clock,
    facts: {
      config,
      snapshot: {
        config,
        repository: "acme/widgets",
        issues: program.issues,
        prs: [],
        parkedLabel: config.tracker.parkedLabel,
        flight: { program, forge: null, after: program.fetchedAt },
      },
    },
    vault: { linear: { apiKey: "lin_test", scope: "own" }, now: clock.now },
  });
  const recorded = recordedFetch({
    linear: (r) => {
      const leaf = {
        ...r.Root[0]!.data.issue,
        identifier: "DEMO-13",
        id: "uuid-demo-13",
        title: "Synthetic worker",
        branchName: "feature/demo-13",
        state: { name: "Todo", type: "unstarted" },
        parent: { identifier: "DEMO-1" },
        labels: { nodes: [{ name: config.tracker.readyLabel }], pageInfo: { hasNextPage: false } },
        comments: { nodes: [], pageInfo: { hasNextPage: false } },
      };
      Object.assign(r, { Brief: Array.from({ length: 8 }, () => ({ data: { issue: leaf } })) });
      // Two pages in the fixture are one complete reading; repeat that sequence.
      r.Children.push({
        data: {
          issues: {
            nodes: [leaf, { ...leaf, identifier: "DEMO-14", id: "uuid-demo-14" }],
            pageInfo: { hasNextPage: false },
          },
        },
      } as never);
      r.Children[1]!.data.issues.pageInfo.hasNextPage = true;
      for (const [key, responses] of Object.entries(r)) {
        if (key !== "Brief") Object.assign(r, { [key]: Array.from({ length: 8 }, () => responses).flat() });
      }
    },
  });
  let creates = 0;
  let missing = false;
  let uncertain = false;
  let failed = false;
  const lines: string[] = [];
  const changes: (() => Promise<void>)[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: "armada_key_TEST" },
    readFile: async (p) => (p.endsWith("armada.toml") ? WATCH_TOML : null),
    stdout: (t) => lines.push(t),
    stderr: (t) => lines.push(t),
    ghToken: () => null,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
      await changes.shift()?.();
    },
    fetch: async (url, init) => {
      if (url.endsWith("/workers/revoke-pending")) {
        const body = JSON.parse(String(init.body));
        const pending = store.launches.find((l) => l.id === body.id);
        if (pending) pending.endedAt = clock.now().toISOString();
        return Response.json({ id: body.id, ticket: body.ticket });
      }
      if (url.endsWith("/launch-tokens/bind")) {
        const body = JSON.parse(String(init.body));
        const pending = store.launches.find((l) => l.id === body.id);
        if (!pending) throw new Error("binding has no pending launch");
        Object.assign(pending, { handle: body.handle, runtime: body.runtime });
        return Response.json({ id: body.id, ticket: body.ticket });
      }
      return url.startsWith(ARMADA_URL) ? api.fetch(url, init) : recorded.fetch(url, init);
    },
    exec: async (command, args) => {
      if (command === "git")
        return {
          code: 0,
          stdout: args[0] === "rev-parse" ? "/work/widgets" : "ref: refs/heads/main\tHEAD",
          stderr: "",
        };
      if (missing) return { code: 127, stdout: "", stderr: "missing" };
      if (args.includes("create")) {
        creates++;
        return failed
          ? { code: 4, stdout: "", stderr: "synthetic failure" }
          : uncertain
            ? { code: 1, stdout: "", stderr: "", timedOut: true }
            : {
                code: 0,
                stdout: JSON.stringify({
                  workspaceId: `ws-${creates}`,
                  sessionId: "ses-1",
                  initialMessage: { messageId: "msg-1", state: "queued" },
                }),
                stderr: "",
              };
      }
      if (args.includes("list")) return { code: 1, stdout: "", stderr: "unavailable" };
      if (args.includes("model"))
        return {
          code: 0,
          stdout: JSON.stringify({ agents: [{ agent: "codex", models: ["synthetic-model"], efforts: ["high"] }] }),
          stderr: "",
        };
      return { code: 0, stdout: "0.90.1", stderr: "" };
    },
  };
  const queue = async (ticket = "DEMO-13", coordinator = "default", profile: string | null = null) => {
    const id = await store.addRequest({
      project: "widgets",
      ticket,
      coordinator,
      kind: "launch-request",
      author: "Ada",
      body: "Wait",
      question: null,
      profile,
      pinned: !!profile,
      deferred: true,
      at: clock.now(),
    });
    if (!id) throw new Error("request missing");
    return id;
  };
  const watch = async (follow = false, minutes = 0.6, extra: readonly string[] = []) => {
    lines.length = 0;
    return run(["watch", "--for", String(minutes), ...(follow ? ["--follow"] : []), ...extra], io);
  };
  return {
    io,
    api,
    store,
    clock,
    program,
    queue,
    watch,
    changes,
    creates: () => creates,
    text: () => lines.join(""),
    missing: () => {
      missing = true;
    },
    uncertain: () => {
      uncertain = true;
    },
    failed: () => {
      failed = true;
    },
  };
}

test.each([false, true])(
  "watch fires an externally unblocked owned request once and stays listening (follow=%s)",
  async (follow) => {
    const f = await watchingLaunches();
    const id = await f.queue();
    await f.queue("DEMO-14", "peer");
    f.program.issues[1]!.blockedBy = [{ id: "DEMO-15", statusType: "unstarted" }];
    f.changes.push(async () => {
      f.program.issues[3]!.statusType = "completed";
    });
    expect(await f.watch(follow)).toBe(0);
    expect(f.creates()).toBe(1);
    expect(f.store.launches).toMatchObject([{ ticket: "DEMO-13", handle: "ws-1/ses-1" }]);
    expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(1);
    expect(f.text()).toContain(follow ? 'launched DEMO-13 "Synthetic worker"' : "No new item");
  },
);

test("watch starts only the oldest waiting request when one of two slots frees", async () => {
  const f = await watchingLaunches();
  await f.queue();
  f.clock.advance(1000);
  const newer = await f.queue("DEMO-14");
  for (const ticket of ["DEMO-15", "DEMO-16"])
    await f.store.saveRuntimeHandle({
      project: "widgets",
      ticket,
      runtime: "conductor",
      handle: `ws/${ticket}`,
      branch: null,
      at: f.clock.now(),
    });
  f.changes.push(async () => {
    await f.store.releaseRuntimeHandle("widgets", "DEMO-15", f.clock.now());
  });
  expect(await f.watch()).toBe(0);
  expect(f.creates(), f.text()).toBe(1);
  expect(f.store.launches[0]?.ticket).toBe("DEMO-13");
  expect((await f.store.getInboxItem("widgets", newer))?.request?.attempts ?? 0).toBe(0);
});

test.each(["preflight", "runtime"])(
  "watch reports %s failure once, retries at five then fifteen minutes, and gives up after three",
  async (mode) => {
    const f = await watchingLaunches();
    const id = await f.queue();
    if (mode === "preflight") f.missing();
    else f.failed();
    for (const [minutes, attempts] of [
      [0, 1],
      [4, 1],
      [5, 2],
      [19, 2],
      [20, 3],
      [60, 3],
    ]) {
      f.clock.advance(NOW.getTime() + minutes! * 60000 - f.clock.now().getTime());
      expect(await f.watch(false, 0.01)).toBe(0);
      expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(attempts);
      const failures = (await f.store.openInboxItems({ project: "widgets", recipient: "coordinator" })).filter(
        (i) => i.kind === "launch-failed",
      );
      expect(failures, f.text()).toHaveLength(1);
      expect(failures[0]?.body).toContain(attempts === 3 ? "gave up after 3 failed launches" : "Conductor");
    }
    expect(f.creates()).toBe(mode === "preflight" ? 0 : 3);
  },
);

test("watch never retries an unknown creation or fires a declined or guided request", async () => {
  const f = await watchingLaunches();
  const id = await f.queue();
  const declined = await f.queue("DEMO-14");
  const guided = await f.queue("DEMO-16", "default", "guided");
  await f.store.resolveInboxItem({ project: "widgets", id: declined, resolution: "declined", at: f.clock.now() });
  f.uncertain();
  expect(await f.watch()).toBe(0);
  expect(f.creates()).toBe(1);
  expect(f.store.launches).toHaveLength(1);
  f.clock.advance(20 * 60000);
  expect(await f.watch()).toBe(0);
  expect(f.creates()).toBe(1);
  expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(1);
  expect((await f.store.getInboxItem("widgets", guided))?.request?.attempts ?? 0).toBe(0);
  expect(f.text()).toContain("armada brief DEMO-16");
  for (const hours of [3, 26]) {
    f.clock.advance(hours * 60 * 60000);
    expect(await f.watch()).toBe(0);
    expect(f.creates()).toBe(1);
    expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(1);
    expect(await run(["launch", "DEMO-13"], f.io)).not.toBe(0);
    expect(await run(["brief", "DEMO-13", "--prompt"], f.io)).not.toBe(0);
    expect(f.creates()).toBe(1);
    expect(f.store.launches).toHaveLength(1);
  }
});

test("a machine-store cleanup failure keeps waiting work visible and resumes after recovery", async () => {
  const f = await watchingLaunches();
  const id = await f.queue();
  const credentials = resolveCredentials({ env: f.io.env });
  const fleet = liveFleet(f.io, parseConfig(WATCH_TOML), credentials).fleet;
  const paths = machinePaths(f.io.env);
  if (!fleet || !paths) throw new Error("fixture has no fleet or machine store");
  const watchDir = join(paths.dir, "watch");
  const backup = `${watchDir}-backup`;
  const fetch = f.io.fetch!;
  let damaged = false;
  f.io.fetch = async (url, init) => {
    if (!damaged && url.endsWith("/fleet/launch-requests")) {
      await rename(watchDir, backup);
      await writeFile(watchDir, "synthetic machine-store failure");
      damaged = true;
      return Response.json({ error: "synthetic admission outage" }, { status: 403 });
    }
    return fetch(url, init);
  };
  // Restore only when the wrapper reaches the underlying inbox, after cleanup.
  let restored = false;
  const wrapped = firingDeferredFleet(
    f.io,
    {
      ...fleet,
      inbox: async (query) => {
        if (!restored) {
          await rm(watchDir);
          await rename(backup, watchDir);
          restored = true;
        }
        return fleet.inbox(query);
      },
    },
    parseConfig(WATCH_TOML),
    "/work/widgets/armada.toml",
    new AbortController().signal,
    credentials,
  );
  const read = await wrapped.inbox({
    coordinator: null,
    coordinatorName: "default",
    silentAfterMinutes: 15,
    etag: null,
  });
  expect(read?.items).toContainEqual(expect.objectContaining({ kind: "launch-request", id, ticket: "DEMO-13" }));
  expect(f.creates()).toBe(0);
  await wrapped.inbox({ coordinator: null, coordinatorName: "default", silentAfterMinutes: 15, etag: null });
  expect(f.creates()).toBe(1);
  expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(1);
});

test.each(["launch-requests", "launch-requests/attempt", "legacy-admission"])(
  "watch retains the action item when %s is unavailable during firing",
  async (operation) => {
    const f = await watchingLaunches();
    await f.queue();
    const fetch = f.io.fetch!;
    let failed = false;
    f.io.fetch = async (url, init) => {
      if (operation === "legacy-admission" && url.endsWith("/fleet/launch-requests/attempt")) {
        const response = await fetch(url, init);
        const body = (await response.json()) as { result: { tokenFence?: true } };
        delete body.result.tokenFence;
        return Response.json(body);
      }
      if (!failed && url.endsWith(`/fleet/${operation}`)) {
        failed = true;
        return Response.json({ error: "synthetic admission outage" }, { status: 403 });
      }
      return fetch(url, init);
    };
    expect(await f.watch()).toBe(0);
    expect(f.creates()).toBe(0);
    expect(f.text()).toContain("DEMO-13");
    expect(f.text()).not.toContain("No new item");
  },
);

test.each([
  { failure: "preflight", operation: "notice" },
  { failure: "preflight", operation: "lookup" },
  { failure: "runtime", operation: "notice" },
])(
  "watch keeps the request visible after $failure failure and an unavailable $operation",
  async ({ failure, operation }) => {
    const f = await watchingLaunches();
    await f.queue();
    if (failure === "preflight") f.missing();
    else f.failed();
    let lookup = false;
    const exec = f.io.exec!;
    f.io.exec = async (command, args, options) => {
      const result = await exec(command, args, options);
      if (command === "conductor" && args.includes("--version") && result.code !== 0) lookup = true;
      return result;
    };
    const fetch = f.io.fetch!;
    f.io.fetch = async (url, init) => {
      if (
        (operation === "notice" && url.endsWith("/fleet/launch/failed")) ||
        (operation === "lookup" && lookup && url.endsWith("/fleet/launches"))
      ) {
        lookup = false;
        return Response.json({ error: "synthetic notice outage" }, { status: 403 });
      }
      return fetch(url, init);
    };
    expect(await f.watch()).toBe(0);
    expect(f.creates()).toBe(failure === "runtime" ? 1 : 0);
    expect(f.text()).toContain("launch-request");
    expect(f.text()).not.toContain("No new item");
  },
);

test("a decline after the final read is refused at token creation", async () => {
  const f = await watchingLaunches();
  const id = await f.queue();
  const fetch = f.io.fetch!;
  f.io.fetch = async (url, init) => {
    if (url.endsWith("/launch-tokens"))
      await f.store.resolveInboxItem({ project: "widgets", id, resolution: "declined", at: f.clock.now() });
    return fetch(url, init);
  };
  expect(await f.watch()).toBe(0);
  expect(f.creates()).toBe(0);
  expect(f.store.launches).toEqual([]);
});

test("declining a request during slow preflight prevents creation at the launch boundary", async () => {
  const f = await watchingLaunches();
  const id = await f.queue();
  const exec = f.io.exec!;
  f.io.exec = async (command, args, options) => {
    if (args.includes("model"))
      await f.store.resolveInboxItem({ project: "widgets", id, resolution: "declined", at: f.clock.now() });
    return exec(command, args, options);
  };
  expect(await f.watch()).toBe(0);
  expect((await f.store.getInboxItem("widgets", id))?.request?.attempts).toBe(1);
  expect(f.creates()).toBe(0);
  expect(f.store.launches).toEqual([]);
});

test("two automatic requests do not wake plain watch between launches", async () => {
  const f = await watchingLaunches();
  await f.queue();
  await f.queue("DEMO-14");
  // The second ticket's fresh brief is independent, while sharing the program reading.
  const fetch = f.io.fetch!;
  f.io.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!url.startsWith(ARMADA_URL) && init?.body && String(init.body).includes("query Brief")) {
      const input = JSON.parse(String(init.body));
      const data = (await response.json()) as { data: { issue: { identifier: string; branchName: string } } };
      data.data.issue.identifier = input.variables.id;
      data.data.issue.branchName = `feature/${input.variables.id.toLowerCase()}`;
      return Response.json(data);
    }
    return response;
  };
  expect(await f.watch()).toBe(0);
  expect(f.creates(), f.text()).toBe(2);
  expect(f.store.launches.map((l) => l.ticket)).toEqual(["DEMO-13", "DEMO-14"]);
  expect(f.text()).toContain("No new item");
});

test.each([
  { flags: ["--tickets", "DEMO-99"], visible: false },
  { flags: ["--kinds", "question"], visible: false },
  { flags: ["--kinds", "launched", "--json"], visible: true },
])("follow respects filters and emits a resumable launched record (%s)", async ({ flags, visible }) => {
  const f = await watchingLaunches();
  await f.queue();
  expect(await f.watch(true, 0.6, flags)).toBe(0);
  expect(f.creates()).toBe(1);
  const records = f
    .text()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  if (visible)
    expect(records).toMatchObject([
      {
        kind: "launched",
        ticket: "DEMO-13",
        id: 1,
        owner: "default",
        new: true,
        cursor: expect.stringMatching(/^v1\./),
      },
    ]);
  else
    expect(
      f
        .text()
        .split("\n")
        .filter((line) => line.startsWith("launched ")),
    ).toEqual([]);
});
