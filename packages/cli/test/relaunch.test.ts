import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armadaApi, fleetClient, recordClaim } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import {
  ARMADA_URL,
  DEMO_PROJECT,
  DEMO_TOML,
  FakeLinear,
  fakeArmada,
  LABELS,
  NOW,
  recordedFetch,
} from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const TOML = `${DEMO_TOML}
[conductor]
default_profile = "backend"
[conductor.profiles.backend]
agent = "codex"
model = "synthetic-model"
effort = "high"
`;
const head = "a".repeat(40);
const branch = "feature/demo-13";
const oldHandle = "ws-old/ses-old";
const json = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
async function fixture(coordinator: string | null = null) {
  const home = await mkdtemp(join(tmpdir(), "armada-relaunch-"));
  homes.push(home);
  let now = new Date(NOW);
  const store = memoryFleet();
  const armada = fakeArmada({
    store,
    keys: { armada_key_CANARY_test: "test" },
    vault: { linear: { apiKey: "lin_api_CANARY", scope: "own" }, now: () => now },
  });
  const linear = new FakeLinear(() => now);
  linear.add("DEMO-13", {
    labels: LABELS.filter((l) => l.name === "implementing" || l.name === "Conductor"),
    agentPhase: "implementing",
    agentRuntime: "Conductor",
    statusType: "started",
    branchName: branch,
  });
  await store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-13",
    handle: oldHandle,
    coordinator,
    runtime: "conductor",
    branch,
    at: new Date(now.getTime() - 1000),
  });
  const briefTicket = {
    identifier: "DEMO-13",
    title: "Synthetic worker",
    url: "https://linear.app/acme/issue/DEMO-13",
    branchName: branch,
    description: "Build a widget.",
    state: { name: "In Progress", type: "started" },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    parent: null,
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  const recorded = recordedFetch({
    linear: (r) => {
      Object.assign(r, { Brief: [{ data: { issue: briefTicket } }] });
      const responses = r as Record<string, unknown[]>;
      for (const [operation, rows] of Object.entries(responses))
        responses[operation] = Array.from({ length: 6 }, () => rows).flat();
    },
  });
  const order: string[] = [],
    output: string[] = [];
  const calls: { args: string[]; input?: string }[] = [];
  let timeoutCreate = false,
    failArchive = false,
    stuck = false;
  let status = "working",
    failCreate = false,
    claimImmediately = false,
    remoteHead = head,
    auth = true;
  const io: Io = {
    cwd: "/work/widgets",
    env: {
      XDG_CONFIG_HOME: home,
      ARMADA_API_URL: ARMADA_URL,
      ARMADA_API_KEY: "armada_key_CANARY_test",
      LINEAR_API_KEY: "lin_api_CANARY",
    },
    readFile: async (p) => (p === "/work/widgets/armada.toml" ? TOML : null),
    stdout: (t) => output.push(t),
    stderr: (t) => output.push(t),
    ghToken: () => null,
    now: () => now,
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    linearWriter: () => linear,
    fetch: async (url, init) => {
      if (url.startsWith(ARMADA_URL)) order.push(url.split("/api/cli/")[1] ?? url);
      if (url.endsWith("/launch-tokens/bind")) {
        const b = JSON.parse(String(init.body));
        if (claimImmediately)
          await recordClaim(
            store,
            "widgets",
            {
              ticket: "DEMO-13",
              runtime: "conductor",
              handle: b.handle,
              branch,
              phase: "planning",
              resuming: false,
              profile: null,
            },
            new Date(now.getTime() + 1000),
          );
        return Response.json({ id: b.id, ticket: b.ticket });
      }
      if (url.endsWith("/workers/revoke-pending")) {
        const body = JSON.parse(String(init.body));
        const row = store.launches.find((l) => l.id === body.id);
        if (row) row.endedAt = now.toISOString();
        return Response.json({ id: body.id, ticket: "DEMO-13" });
      }
      if (url.endsWith("/launch-tokens")) {
        const response = await armada.fetch(url, init);
        const body = (await response.clone().json()) as { worker: { id: string } };
        store.launches.push({
          id: body.worker.id,
          project: "widgets",
          ticket: "DEMO-13",
          launchedAt: now.toISOString(),
          tokenUsedAt: null,
          runtime: "conductor",
          handle: null,
          endedAt: null,
        });
        return response;
      }
      return url.startsWith(ARMADA_URL) ? armada.fetch(url, init) : recorded.fetch(url, init);
    },
    exec: async (command, args, options) => {
      if (command === "git")
        return {
          code: 0,
          stderr: "",
          stdout:
            args[0] === "rev-parse"
              ? "/work/widgets\n"
              : args.includes("--symref")
                ? "ref: refs/heads/trunk\tHEAD\n"
                : remoteHead
                  ? `${remoteHead}\trefs/heads/${branch}\n`
                  : "",
        };
      calls.push({ args, input: options.input });
      const [kind, op, id] = args.slice(1);
      if (kind === "--version") return { code: 0, stdout: "0.90.1", stderr: "" };
      if (kind === "auth") return { code: auth ? 0 : 3, stdout: "", stderr: "armada_launch_CANARY_1" };
      if (kind === "model")
        return json({
          agents: [{ agent: "codex", models: ["synthetic-model"], efforts: ["high"], fastModeModels: [] }],
        });
      if (kind === "workspace" && op === "status") return json({ workspaceId: id, status: "ready" });
      if (kind === "session" && (op === "get" || op === "status"))
        return json({ id, sessionId: id, workspaceId: "ws-old", status, agent: "codex" });
      if (op === "cancel") {
        order.push("cancel");
        if (!stuck) status = "idle";
        return json({ status });
      }
      if (op === "create") {
        order.push("create");
        if (timeoutCreate) return { code: 1, stdout: "", stderr: "", timedOut: true };
        if (failCreate) return { code: 4, stdout: "armada_launch_CANARY_1", stderr: "armada_launch_CANARY_1" };
        return json({
          id: "ses-new",
          workspaceId: "ws-new",
          sessionId: "ses-new",
          initialMessage: { messageId: "msg-new", state: "queued" },
        });
      }
      if (op === "archive") {
        order.push(`archive:${id}`);
        if (failArchive) return { code: 4, stdout: "", stderr: "" };
        return json({ status: "archived" });
      }
      throw new Error(`unexpected exec ${command} ${args.join(" ")}`);
    },
  };
  return {
    io,
    store,
    armada,
    linear,
    briefTicket,
    order,
    calls,
    set: (options: {
      failCreate?: boolean;
      claimImmediately?: boolean;
      remoteHead?: string;
      auth?: boolean;
      timeoutCreate?: boolean;
      failArchive?: boolean;
      stuck?: boolean;
      status?: string;
    }) => {
      timeoutCreate = options.timeoutCreate ?? timeoutCreate;
      failArchive = options.failArchive ?? failArchive;
      stuck = options.stuck ?? stuck;
      status = options.status ?? status;
      failCreate = options.failCreate ?? failCreate;
      claimImmediately = options.claimImmediately ?? claimImmediately;
      remoteHead = options.remoteHead ?? remoteHead;
      auth = options.auth ?? auth;
    },
    text: () => {
      const text = output.join("");
      expect(text).not.toContain("armada_launch_CANARY_1");
      expect(text).not.toContain("lin_api_CANARY");
      return text;
    },
    relaunch: (...args: string[]) => run(["relaunch", "DEMO-13", "--reason", "session died", ...args], io),
  };
}

test("fresh relaunch cancels, releases and ends the old generation before launching and archiving it", async () => {
  const f = await fixture();
  await f.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-13",
    kind: "report",
    prUrl: "https://github.com/acme/widgets/pull/42",
    at: NOW,
  });
  await f.store.putHandBack({ project: "widgets", ticket: "DEMO-13", author: oldHandle, body: "PR is open", at: NOW });
  await f.store.reserve({ project: "widgets", ticket: "DEMO-13", key: "db-migration", value: "23", at: NOW });
  const fetch = f.io.fetch as NonNullable<Io["fetch"]>;
  f.io.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith("/workers/end"))
      await f.store.reserve({ project: "widgets", ticket: "DEMO-14", key: "db-migration", value: "23", at: NOW });
    return response;
  };
  f.set({ claimImmediately: true });
  const old = await f.store.getRuntimeHandle("widgets", "DEMO-13");
  const result = await f.relaunch("--fresh");
  expect(result, f.text()).toBe(0);
  const ordered = f.order.filter((x) =>
    [
      "cancel",
      "fleet/release",
      "workers/end",
      "launch-tokens",
      "create",
      "launch-tokens/bind",
      "archive:ws-old",
    ].includes(x),
  );
  expect(ordered).toEqual([
    "cancel",
    "fleet/release",
    "workers/end",
    "launch-tokens",
    "create",
    "launch-tokens/bind",
    "archive:ws-old",
  ]);
  const create = f.calls.find((c) => c.args[2] === "create");
  expect(create?.args).toContain(branch);
  expect(create?.input).toContain("## Continuing earlier work");
  expect(create?.input).toContain(head);
  expect(create?.input).toContain("session died");
  expect(create?.input).toContain("Pull request #42 is open");
  expect(create?.input).toContain("never open a second one, never force-push");
  expect(create?.input).toContain("armada reserve db-migration --value 23");
  expect(create?.input).toContain("If a previous value is now held by another ticket, stop and ask the coordinator");
  expect(create?.input).toContain("- db-migration = 23: DEMO-14");
  expect(create?.input).not.toContain("- db-migration = 23: DEMO-13");
  expect(
    await f.store.releaseRuntimeHandle("widgets", "DEMO-13", NOW, { handle: oldHandle, claimedAt: old?.claimedAt }),
  ).toBe(false);
  expect(
    (await f.store.openInboxItems({ project: "widgets", recipient: "coordinator", ticket: "DEMO-13" })).some(
      (i) => i.kind === "hand-back",
    ),
  ).toBe(false);
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.handle).toBe("ws-new/ses-new");
  expect(f.text()).toContain("Relaunched DEMO-13");
  expect(f.text()).toContain("DEMO-13: Missing ## In short section.");
  expect(f.text()).not.toContain("launching again makes a second worker");
});

test("relaunch refuses a ticket that becomes Done during cancellation", async () => {
  const f = await fixture();
  expect(f.linear.get("DEMO-13").statusType).toBe("started");
  const exec = f.io.exec;
  if (!exec) throw new Error("missing fake runtime");
  f.io.exec = async (command, args, options) => {
    const result = await exec(command, args, options);
    if (args[2] === "cancel") await f.linear.updateTicket("uuid-DEMO-13", { stateId: "st-done" });
    return result;
  };
  expect(await f.relaunch("--fresh"), f.text()).toBe(2);
  expect(f.order).toContain("cancel");
  expect(f.text()).toContain("is completed; there is nothing to work on");
  expect(f.linear.get("DEMO-13").stateId).toBe("st-done");
  expect(f.order).not.toContain("fleet/release");
  expect(f.order).not.toContain("workers/end");
  expect(f.order).not.toContain("launch-tokens");
  expect(f.order).not.toContain("create");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.releasedAt).toBeNull();
});

test("known launch failure names the released state and releases the lease", async () => {
  const f = await fixture();
  f.set({ failCreate: true });
  const result = await f.relaunch("--fresh", "--reason", "session died lin_api_CANARY");
  expect(result, f.text()).toBe(1);
  expect(f.linear.bodies.join("\n")).not.toContain("lin_api_CANARY");
  expect(f.calls.find((call) => call.args[2] === "create")?.input).not.toContain("lin_api_CANARY");
  expect(f.text()).toContain("DEMO-13 is released, nobody holds it: armada launch DEMO-13");
  expect(f.order).toContain("workers/revoke-pending");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.releasedAt).not.toBeNull();
  expect((await f.linear.readTicket("DEMO-13"))?.agentPhase).toBeNull();
  expect(f.store.leases.size).toBe(0);
});

test("default in-place launches a new session and archives only the old session", async () => {
  const f = await fixture();
  f.set({ claimImmediately: true });
  const result = await f.relaunch();
  expect(result, f.text()).toBe(0);
  expect(f.calls.find((c) => c.args[2] === "create")?.args.slice(1, 5)).toEqual([
    "session",
    "create",
    "--workspace",
    "ws-old",
  ]);
  expect(f.calls.find((c) => c.args[2] === "create")?.input).toContain("check `git status` first");
  expect(f.order).toContain("archive:ses-old");
  expect(f.order).not.toContain("archive:ws-old");
  f.text();
});

test("preflight refusal and a competing launch lease leave the old owner intact", async () => {
  for (const mode of ["auth", "lease", "validation"] as const) {
    const f = await fixture();
    if (mode === "auth") f.set({ auth: false });
    else if (mode === "lease")
      await f.store.acquireLease({
        project: "widgets",
        name: "launch:DEMO-13",
        holder: "another",
        at: NOW,
        ttlMs: 300000,
      });
    else
      f.io.readFile = async (path) =>
        path === "/work/widgets/armada.toml"
          ? `${TOML}\n[[policy.validation]]\nwhen="design"\nthen="show the owner"`
          : null;
    const result = await f.relaunch("--fresh", "--reason", "session died lin_api_CANARY");
    expect(result, f.text()).toBe(2);
    expect(f.order).not.toContain("cancel");
    expect(f.order).not.toContain("fleet/release");
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.releasedAt).toBeNull();
    f.text();
    if (mode === "validation") {
      expect(f.text()).toContain("--validation none");
      expect(
        await f.relaunch("--fresh", "--validation", "1", "--validation-reason", "design lin_api_CANARY"),
        f.text(),
      ).toBe(0);
      const prompt = f.calls.find((call) => call.args[2] === "create")?.input;
      expect(prompt).toContain("show the owner");
      expect(prompt).not.toContain("lin_api_CANARY");
    }
  }
});

test("timeout leaves ownership intact; an uncertain in-place create retains its launch instead of reporting nobody", async () => {
  const stopped = await fixture();
  stopped.set({ stuck: true });
  expect(await stopped.relaunch()).toBe(2);
  expect(stopped.text()).toContain("the old worker did not stop");
  expect(stopped.order).not.toContain("fleet/release");
  const uncertain = await fixture();
  uncertain.set({ timeoutCreate: true });
  expect(await uncertain.relaunch()).toBe(1);
  expect(uncertain.text()).toContain("a pending launch remains");
  expect(uncertain.text()).not.toContain("nobody holds it");
  expect(uncertain.order).not.toContain("workers/revoke-pending");
  expect(uncertain.order.filter((x) => x === "create")).toHaveLength(1);
});

test("archive failure keeps the replacement alive, while keep-old and dry-run have their stated scope", async () => {
  const warning = await fixture();
  warning.set({ failArchive: true, claimImmediately: true });
  expect(await warning.relaunch("--fresh")).toBe(0);
  expect(warning.text()).toContain("replacement is running");
  expect((await warning.store.getRuntimeHandle("widgets", "DEMO-13"))?.handle).toBe("ws-new/ses-new");
  for (const state of ["active", "pending"] as const) {
    const reused = await fixture();
    reused.set({ claimImmediately: state === "active" });
    const originalFetch = reused.io.fetch;
    reused.io.fetch = async (url, init) => {
      if (!originalFetch) throw new Error("missing fake API");
      const response = await originalFetch(url, init);
      if (url.endsWith("/launch-tokens/bind")) {
        if (state === "active")
          await reused.store.saveRuntimeHandle({
            project: "widgets",
            ticket: "DEMO-14",
            runtime: "conductor",
            handle: oldHandle,
            branch: "feature/demo-14",
            at: NOW,
          });
        else
          reused.store.launches.push({
            project: "widgets",
            ticket: "DEMO-14",
            id: "wk-shared",
            runtime: "conductor",
            handle: oldHandle,
            launchedAt: NOW.toISOString(),
            tokenUsedAt: null,
            endedAt: null,
          });
      }
      return response;
    };
    expect(await reused.relaunch()).toBe(0);
    expect(reused.order).not.toContain("archive:ses-old");
    expect(reused.text()).toContain("Next: armada status");
    if (state === "active") expect((await reused.store.getRuntimeHandle("widgets", "DEMO-14"))?.releasedAt).toBeNull();
    else expect(reused.store.launches.find((l) => l.id === "wk-shared")?.endedAt).toBeNull();
  }
  const kept = await fixture();
  expect(await kept.relaunch("--keep-old")).toBe(0);
  expect(kept.order.some((x) => x.startsWith("archive:"))).toBe(false);
  for (const json of [false, true]) {
    const dry = await fixture();
    expect(await dry.relaunch("--dry-run", ...(json ? ["--json"] : []))).toBe(0);
    expect(
      dry.order.some((x) => ["cancel", "create", "fleet/release", "launch-tokens"].includes(x) || x.includes("lease/")),
    ).toBe(false);
    if (json) {
      const result = JSON.parse(dry.text());
      expect(result).toMatchObject({ title: "Synthetic worker", dryRun: true, mode: "in-place", head });
      expect(result.preflight.warnings).toContain(
        "DEMO-13: Missing ## In short section. Fix: Add ## In short with What changes, Why, Done when, Depends on.",
      );
    } else expect(dry.text()).toContain('Relaunch plan for DEMO-13 "Synthetic worker"');
  }
});

test("a failed Linear release is retryable without ending the replacement or changing its branch", async () => {
  const f = await fixture();
  const update = f.linear.updateTicket.bind(f.linear);
  let fail = true;
  f.linear.updateTicket = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("synthetic outage");
    }
    return update(...args);
  };
  expect(await f.relaunch("--fresh")).toBe(2);
  expect(f.text()).toContain("release is incomplete");
  expect(f.order).not.toContain("launch-tokens");
  const resumed = await f.relaunch("--fresh");
  expect(resumed, f.text()).toBe(0);
  expect(f.text()).toContain("Relaunched DEMO-13");
});

test("a bound launch that never claimed is revoked by its exact id before replacement", async () => {
  const f = await fixture();
  await f.store.releaseRuntimeHandle("widgets", "DEMO-13", NOW);
  f.store.launches.push({
    id: "wk-old",
    project: "widgets",
    ticket: "DEMO-13",
    launchedAt: NOW.toISOString(),
    runtime: "conductor",
    handle: oldHandle,
    tokenUsedAt: null,
    endedAt: null,
  });
  const apiFleet = fleetClient({
    api: armadaApi({ url: ARMADA_URL, fetch: f.io.fetch }),
    signIn: { kind: "api-key", key: "armada_key_CANARY_test" },
    project: DEMO_PROJECT,
  });
  // Pending launches have no recorded branch. The real API projection must
  // still authorize this exact launch, including ended-generation cleanup.
  expect(
    (
      await apiFleet.runtimeReference({
        ticket: "DEMO-13",
        runtime: "conductor",
        handle: oldHandle,
        claimedAt: null,
        launchId: "wk-old",
        releasedAt: null,
        branch,
      })
    )?.branch,
  ).toBeUndefined();
  f.set({ claimImmediately: true });
  const result = await f.relaunch("--fresh");
  expect(result, f.text()).toBe(0);
  expect(f.order.indexOf("workers/revoke-pending")).toBeLessThan(f.order.indexOf("launch-tokens"));
  expect(f.order).not.toContain("fleet/release");
  expect(f.store.launches.find((l) => l.id === "wk-old")?.endedAt).not.toBeNull();
  expect(f.order).toContain("archive:ws-old");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.handle).toBe("ws-new/ses-new");
  f.text();
});

test("a concurrent merge or lost relaunch lease prevents cancellation and release", async () => {
  const merging = await fixture();
  await merging.store.acquireLease({ project: "widgets", name: "merge", holder: "another", at: NOW, ttlMs: 300000 });
  expect(await merging.relaunch("--fresh")).toBe(2);
  expect(merging.text()).toContain("a merge is in progress");
  expect(merging.order).not.toContain("cancel");
  const lost = await fixture();
  lost.store.renewLease = async () => false;
  expect(await lost.relaunch()).toBe(2);
  expect(lost.text()).toContain("lease was lost");
  expect(lost.order).not.toContain("cancel");
  expect(lost.order).not.toContain("fleet/release");
  for (const when of ["before", "during"] as const) {
    const held = await fixture();
    const open = () =>
      held.store.openHold({ project: "widgets", kind: "manual", reason: "inspect main", author: null, at: NOW });
    if (when === "before") await open();
    else {
      const exec = held.io.exec as NonNullable<Io["exec"]>;
      held.io.exec = async (command, args, options) => {
        const result = await exec(command, args, options);
        if (args[2] === "cancel") await open();
        return result;
      };
    }
    held.set({ claimImmediately: true });
    expect(await held.relaunch("--fresh"), held.text()).toBe(0);
    expect((await held.store.getRuntimeHandle("widgets", "DEMO-13"))?.handle).toBe("ws-new/ses-new");
    expect(await held.store.openHolds("widgets")).toHaveLength(1);
    const fleet = fleetClient({
      api: armadaApi({ url: ARMADA_URL, fetch: held.armada.fetch }),
      signIn: { kind: "api-key", key: "armada_key_CANARY_test" },
      project: DEMO_PROJECT,
    });
    await expect(fleet.acquireLease({ name: "merge", holder: "merger-after", ttlMs: 300000 })).rejects.toThrow("hold");
  }
});

test("an unavailable local herdr pane cannot use the remote-machine exception to release a surviving checkout", async () => {
  const f = await fixture();
  const handle = JSON.stringify({ workspace: "w8", pane: "w8:p9", agent: "demo-13" });
  await f.store.saveRuntimeHandle({ project: "widgets", ticket: "DEMO-13", runtime: "herdr", handle, branch, at: NOW });
  const original = f.io.exec;
  let inspectedCheckout = false;
  f.io.exec = async (command, args, options) => {
    if (command === "herdr") {
      if (args[0] === "workspace")
        return json({
          result: {
            workspace: {
              workspace_id: "w8",
              worktree: {
                repo_root: "/work/widgets",
                checkout_path: "/work/trees/demo-13",
                is_linked_worktree: true,
              },
            },
          },
        });
      if (args[0] === "agent")
        return { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found" } }), stderr: "" };
      throw new Error("unexpected native mutation");
    }
    if (command === "git" && args.includes("--git-common-dir"))
      return { code: 0, stdout: "/work/widgets/.git", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current")
      return { code: 0, stdout: branch, stderr: "" };
    if (command === "git" && args[0] === "status") {
      inspectedCheckout = true;
      return { code: 0, stdout: " M widget.ts", stderr: "" };
    }
    if (!original) throw new Error("missing fake exec");
    return original(command, args, options);
  };
  expect(await f.relaunch("--fresh", "--keep-old")).toBe(2);
  expect(inspectedCheckout).toBe(true);
  expect(f.order).not.toContain("fleet/release");
  expect(f.order).not.toContain("launch-tokens");
  expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.releasedAt).toBeNull();
});

test("relaunch pre-approval checks before stopping and applies between release and token creation", async () => {
  const f = await fixture();
  const update = f.linear.updateTicket.bind(f.linear);
  f.linear.updateTicket = async (id, change) => {
    if (change.addLabelIds?.includes("plan-approved")) f.order.push("pre-approve");
    await update(id, change);
  };
  expect(
    await f.relaunch("--fresh", "--pre-approve", "--profile", "backend", "--reason-profile", "same backend"),
    f.text(),
  ).toBe(0);
  expect(f.order.indexOf("pre-approve")).toBeGreaterThan(f.order.indexOf("workers/end"));
  expect(f.order.indexOf("pre-approve")).toBeLessThan(f.order.indexOf("launch-tokens"));
  const prompt = f.calls.find((c) => c.args[2] === "create")?.input;
  expect(prompt).toContain("## Continuing earlier work");
  expect(prompt).toContain("added at launch: session died");
  expect(prompt).toContain("same backend");
  expect((await f.linear.readTicket("DEMO-13"))?.labels.some((l) => l.name === "plan-approved")).toBe(true);

  const preview = await fixture();
  expect(await preview.relaunch("--pre-approve", "--dry-run", "--json"), preview.text()).toBe(0);
  expect(JSON.parse(preview.text()).preApproval).toContain("Would add plan-approved");
  expect(preview.linear.writes).toEqual([]);
  expect(preview.order).not.toContain("cancel");
  expect(preview.order).not.toContain("launch-tokens");

  const refused = await fixture();
  refused.linear.add("DEMO-13", { labels: [{ id: "needs-approval", name: "needs-plan-approval", group: null }] });
  expect(await refused.relaunch("--pre-approve"), refused.text()).toBe(2);
  expect(refused.text()).toContain("remove needs-plan-approval first");
  expect(refused.order).not.toContain("cancel");
  expect(refused.order).not.toContain("fleet/release");
  expect((await refused.store.getRuntimeHandle("widgets", "DEMO-13"))?.releasedAt).toBeNull();
});

test("relaunch keeps authenticated launch ownership across claimed, pending, unowned and handed-over generations", async () => {
  for (const mode of ["claimed", "released", "pending", "unowned", "handover", "pending-handover"] as const) {
    const pending = mode === "pending" || mode === "pending-handover";
    const f = await fixture(mode === "unowned" ? null : pending ? "back" : "front");
    f.io.env.ARMADA_COORDINATOR = "back";
    if (pending || mode === "released") await f.store.releaseRuntimeHandle("widgets", "DEMO-13", NOW);
    if (pending)
      f.store.launches.push({
        id: "wk-old",
        project: "widgets",
        ticket: "DEMO-13",
        coordinator: "front",
        launchedAt: NOW.toISOString(),
        runtime: "conductor",
        handle: oldHandle,
        tokenUsedAt: null,
        endedAt: null,
      });
    const handedOver = mode === "handover" || mode === "pending-handover";
    if (handedOver) {
      const exec = f.io.exec as NonNullable<Io["exec"]>;
      f.io.exec = async (command, args, options) => {
        const result = await exec(command, args, options);
        if (args[2] === "cancel")
          expect(
            await f.store.transferTickets({
              project: "widgets",
              tickets: ["DEMO-13"],
              from: "front",
              to: "ops",
              at: NOW,
            }),
          ).toBe(true);
        return result;
      };
    }
    expect(await f.relaunch("--fresh"), `${mode}: ${f.text()}`).toBe(0);
    const expected = mode === "unowned" ? null : handedOver ? "ops" : "front";
    const minted = [...f.armada.launches.entries()].at(-1);
    expect(minted?.[1].coordinator, mode).toBe(expected);
    const api = armadaApi({ url: ARMADA_URL, fetch: f.armada.fetch });
    const session = await api.exchangeLaunchToken(minted?.[0] ?? "missing");
    await fleetClient({
      api,
      signIn: { kind: "worker", token: session.token, ticket: "DEMO-13", project: "widgets" },
      project: DEMO_PROJECT,
    }).claim({
      ticket: "DEMO-13",
      runtime: "conductor",
      handle: "ws-new/ses-new",
      branch,
      phase: "planning",
      resuming: false,
      profile: null,
      coordinator: "back",
    });
    expect((await f.store.getRuntimeHandle("widgets", "DEMO-13"))?.coordinator, mode).toBe(expected);
  }
});
