import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { NodeProvider, WorkerObservation, WorkerRef } from "@armada/plugin-api";
import type { Ticket } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { activate as activateClaude } from "../../plugins/claude/src/index.ts";
import { createLocalNode } from "../../plugins/node-local/src/index.ts";
import { eventually } from "../../plugins/node-local/test/support.ts";
import { nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { bootDaemon } from "../src/boot.ts";
import { fold } from "../src/fold.ts";
import { Workers } from "../src/workers/service.ts";
import { startWorkerSocket } from "../src/workers/socket.ts";

const at = "2030-01-01T00:00:00.000Z";
const project = "orchard";
async function until(workers: Workers, expected: (value: WorkerObservation) => boolean) {
  let observation!: WorkerObservation;
  await eventually(async () => {
    observation = await workers.observe(project, "SEED-1");
    return expected(observation);
  });
  return observation;
}
function socketCall(
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path, path: "/worker", method: "POST", headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function fixture(
  t: TestContext,
  wrap?: (node: NodeProvider) => NodeProvider,
  refresh?: (store: import("../src/store.ts").EventStore) => Promise<void>,
  now = () => at,
) {
  const directory = await mkdtemp(join(tmpdir(), "armada-worker-"));
  const repository = join(directory, "repo");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  await writeFile(join(repository, "README.md"), "# Orchard\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Initial",
  ]);
  const nodeManifest = JSON.parse(
    await readFile(new URL("../../plugins/node-local/package.json", import.meta.url), "utf8"),
  ).armada;
  const claudeManifest = JSON.parse(
    await readFile(new URL("../../plugins/claude/package.json", import.meta.url), "utf8"),
  ).armada;
  let token = "";
  let workspacePath = "";
  const messages: string[] = [];
  let local: NodeProvider;
  let reference: WorkerRef;
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: [
        {
          id: "claude",
          config: {
            runtime: {
              claude: {
                command: process.execPath,
                args: [fileURLToPath(new URL("./support/claude-worker.mjs", import.meta.url))],
              },
            },
          },
        },
      ],
    }),
  );
  const daemon = await bootDaemon({
    databasePath: join(directory, "fleet.sqlite"),
    configPath,
    secrets: { get: async () => null },
    log: {
      info() {},
      error(line) {
        throw new Error(line);
      },
    },
    catalog: [
      {
        id: "node-local",
        manifest: nodeManifest,
        load: async () => ({
          activate(ctx) {
            const raw = createLocalNode({ workspaceRoot: join(directory, "workspaces"), transport: "pipe" });
            local = raw;
            const provider = wrap?.(raw) ?? raw;
            ctx.register.node("local", {
              ...provider,
              async deliver(ref, message, key) {
                messages.push(message);
                return provider.deliver(ref, message, key);
              },
              async launch(request) {
                workspacePath = request.workspace.path;
                token = request.env.ARMADA_WORKER_TOKEN ?? "";
                reference = await provider.launch(request);
                return reference;
              },
            });
          },
        }),
      },
      { id: "claude", manifest: claudeManifest, load: async () => ({ activate: activateClaude }) },
    ],
  });
  daemon.store.append({
    project,
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: {
      id: "SEED-1",
      title: "Plant",
      labels: ["Ｂackend Work", "ready-for-agent"],
      status: "unstarted",
      description: "Plant the orchard safely.",
      branchName: "worker/seed-1",
      blockers: [],
    },
  });
  daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        reason: "Fixture",
        rules: {
          revision: 1,
          value: {
            routing: [{ labels: ["backend-work"], cli: "claude", model: "fixture" }],
            defaultRoute: { cli: "codex", model: "not-selected" },
            placement: { workers: "local", coordinator: "local" },
            policy: { maxWorkers: 1 },
          },
        },
      },
    },
  });
  const socketPath = join(directory, "worker.sock");
  const workers = new Workers({
    store: daemon.store,
    registry: daemon.registry,
    socketPath,
    projects: [{ id: project, repository: "example/orchard", checkout: repository }],
    ...(refresh ? { refresh: () => refresh(daemon.store) } : {}),
    now,
  });
  const socket = await startWorkerSocket(workers, socketPath);
  const scope = openCoordinatorStorage({ store: daemon.store, project, now: () => at });
  const tools = nativeTools(scope, { now: () => at, workers });
  const api = (callId: string) => ({ callId, taskId: 1 }) as ToolExecutionApi;
  t.after(async () => {
    await scope.close(context);
    await workers.close();
    await socket.close();
    daemon.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    daemon,
    repository,
    workers,
    socketPath,
    token: () => token,
    workspace: () => workspacePath,
    messages,
    tools,
    api,
    inspect: () => local.observe(reference),
  };
}

test("native tools launch a bound CLI, deliver, observe working/idle, authorize socket commands and stop one generation", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "bad..branch", brief: "hold" },
        f.api("bad-branch"),
        context,
      )
    ).isError,
    true,
  );
  assert.equal(f.token(), "", "a rejected worktree must not start a CLI");
  const launched = await f.tools["worker.launch"].execute(
    { ticket: "SEED-1", branch: "worker/seed-1", brief: "hold" },
    f.api("launch"),
    context,
  );
  assert.equal(launched.isError, false);
  await until(f.workers, (value) => value.activity === "working");
  const claimed = await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" });
  assert.equal(claimed.status, 200);
  const session = claimed.body.session;
  assert.equal(
    (
      await socketCall(f.socketPath, f.token(), {
        command: "report",
        ticket: "SEED-1",
        phase: "implementing",
        message: `Progress ${f.token()}`,
      })
    ).status,
    200,
  );
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "heartbeat", ticket: "SEED-1" })).status, 200);
  assert.equal(
    (
      await socketCall(f.socketPath, f.token(), {
        command: "ask",
        ticket: "SEED-1",
        key: "choice",
        question: "Which seed?",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await socketCall(f.socketPath, f.token(), {
        command: "report",
        ticket: "SEED-2",
        phase: "implementing",
        message: "Cross-ticket write",
      })
    ).status,
    403,
  );
  assert.equal((await socketCall(f.socketPath, "invalid", { command: "heartbeat", ticket: "SEED-1" })).status, 403);
  const delivered = await f.tools["worker.message"].execute(
    { ticket: "SEED-1", message: "finish" },
    f.api("message"),
    context,
  );
  assert.equal(delivered.isError, false);
  await until(f.workers, (value) => value.activity === "idle" && value.reply === "reply:finish");
  const before = f.daemon.store.sequence;
  assert.equal(
    (await f.tools["worker.message"].execute({ ticket: "SEED-1", message: "finish" }, f.api("message"), context))
      .isError,
    false,
  );
  assert.equal(f.daemon.store.sequence, before, "replayed delivery reuses its receipt");
  assert.equal(
    (await f.tools["worker.message"].execute({ ticket: "SEED-1", message: "auth-error" }, f.api("auth-error"), context))
      .isError,
    false,
  );
  await until(f.workers, (value) => value.state === "failed" && value.reply === "Authentication unavailable");
  assert.equal(
    (await f.tools["worker.message"].execute({ ticket: "SEED-1", message: "recovered" }, f.api("recovered"), context))
      .isError,
    false,
  );
  await until(
    f.workers,
    (value) => value.state === "running" && value.activity === "idle" && value.reply === "reply:recovered",
  );
  const stopped = await f.tools["worker.stop"].execute(
    { ticket: "SEED-1", reason: "Finished" },
    f.api("stop"),
    context,
  );
  assert.equal(stopped.isError, false);
  assert.equal((stopped.details as { disposed: boolean }).disposed, true);
  await assert.rejects(stat(f.workspace()), { code: "ENOENT" });
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "heartbeat", ticket: "SEED-1" })).status, 403);
  const events = f.daemon.store.readSince(0, project);
  assert.equal(
    JSON.stringify(events).includes(f.token()),
    false,
    "tokens never enter events, including worker reports",
  );
  const observations = events.flatMap((event) => (event.kind === "session.runtime-observed" ? [event.payload] : []));
  assert(observations.some((value) => value.activity === "working"));
  assert(observations.some((value) => value.activity === "idle"));
  assert.equal(observations.at(-1)?.state, "stopped");
  const final = fold(events).projects[project]?.sessions[0];
  assert(final);
  assert.equal(final.session, session);
  assert.equal(final.phase, "released");
  const oldToken = f.token();
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/seed-next", brief: "hold" },
        f.api("next"),
        context,
      )
    ).isError,
    false,
  );
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 200);
  assert.equal((await socketCall(f.socketPath, oldToken, { command: "heartbeat", ticket: "SEED-1" })).status, 403);
  assert.equal(
    (await socketCall(f.socketPath, f.token(), { command: "release", ticket: "SEED-1", reason: "Worker done" })).status,
    200,
  );
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 403);
  assert.equal(
    (
      await f.tools["worker.stop"].execute(
        { ticket: "SEED-1", reason: "Clean up released process" },
        f.api("stop-next"),
        context,
      )
    ).isError,
    false,
  );
});

test("a generation changed during node provenance cannot receive the pending native write", {
  timeout: 15000,
}, async (t) => {
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let proceed!: () => void;
  const proceedGate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const f = await fixture(t, (node) => ({
    ...node,
    async deliver(ref, message, key) {
      if (message.includes("stale-message")) {
        entered();
        await proceedGate;
      }
      return node.deliver(ref, message, key);
    },
  }));
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/seed-1", brief: "hold" },
        f.api("launch"),
        context,
      )
    ).isError,
    false,
  );
  await until(f.workers, (value) => value.activity === "working");
  const pending = f.tools["worker.message"].execute(
    { ticket: "SEED-1", message: "stale-message" },
    f.api("stale"),
    context,
  );
  await enteredGate;
  const original = fold(f.daemon.store.readSince(0, project)).projects[project]?.sessions[0];
  assert(original);
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "session.released",
    payload: { ticket: "SEED-1", session: original.session, reason: "Retired during provenance" },
  });
  proceed();
  assert.equal((await pending).isError, true);
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 403);
  await f.workers.close();
  assert.equal(
    (await f.inspect()).reply?.includes("stale-message"),
    false,
    "the actual process never received the stale message",
  );
});

for (const change of [
  { status: "canceled" as const },
  { labels: ["frontend"] },
  { labels: ["backend-work"] },
  { blockers: [{ id: "SEED-9", status: "started" as const }] },
]) {
  test(`launch rechecks fresh ticket facts after preparation: ${JSON.stringify(change)}`, {
    timeout: 15000,
  }, async (t) => {
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let proceed!: () => void;
    const proceedGate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let preparedPath = "";
    const f = await fixture(t, (node) => ({
      ...node,
      async prepare(request) {
        const workspace = await node.prepare(request);
        preparedPath = workspace.path;
        entered();
        await proceedGate;
        return workspace;
      },
    }));
    const launched = f.tools["worker.launch"].execute(
      { ticket: "SEED-1", branch: "worker/changed", brief: "hold" },
      f.api("changed"),
      context,
    );
    await enteredGate;
    assert.equal((await stat(preparedPath)).isDirectory(), true);
    f.daemon.store.append({
      project,
      at,
      actor: "tracker",
      kind: "ticket.seen",
      payload: { id: "SEED-1", title: "Changed", status: "unstarted", labels: ["backend"], ...change },
    });
    proceed();
    assert.equal((await launched).isError, true);
    assert.equal(f.token(), "", "no CLI was started after its launch facts changed");
    await assert.rejects(stat(preparedPath), { code: "ENOENT" });
  });
}

test("known failed CLI spawn retires its intent and clean workspace so a corrected call can launch", {
  timeout: 15000,
}, async (t) => {
  let fail = true;
  let failedPath = "";
  const f = await fixture(t, (node) => ({
    ...node,
    async launch(request) {
      if (fail) {
        fail = false;
        failedPath = request.workspace.path;
        return node.launch({ ...request, command: join(failedPath, "missing-cli") });
      }
      return node.launch(request);
    },
  }));
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/failed", brief: "hold" },
        f.api("missing"),
        context,
      )
    ).isError,
    true,
  );
  await assert.rejects(stat(failedPath), { code: "ENOENT" });
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/corrected", brief: "hold" },
        f.api("corrected"),
        context,
      )
    ).isError,
    false,
  );
  await until(f.workers, (value) => value.activity === "working");
});

test("shutdown revokes every capability and stops later workers after one provider refuses stop", {
  timeout: 15000,
}, async (t) => {
  let refuseFirst = true;
  const f = await fixture(t, (node) => ({
    ...node,
    async stop(ref) {
      if (ref.ticket === "SEED-1" && refuseFirst) {
        refuseFirst = false;
        throw new Error("Fixture stop refusal");
      }
      return node.stop(ref);
    },
  }));
  const rules = fold(f.daemon.store.readSince(0, project)).projects[project]?.rules;
  assert(rules);
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        reason: "Capacity",
        rules: { revision: 2, value: { ...rules.value, policy: { maxWorkers: 2 } } },
      },
    },
  });
  f.daemon.store.append({
    project,
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: {
      id: "SEED-2",
      title: "Second",
      labels: ["backend-work", "ready-for-agent"],
      status: "unstarted",
      blockers: [],
    },
  });
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/first", brief: "hold" },
        f.api("first"),
        context,
      )
    ).isError,
    false,
  );
  const firstToken = f.token();
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-2", branch: "worker/second", brief: "hold" },
        f.api("second"),
        context,
      )
    ).isError,
    false,
  );
  await assert.rejects(f.workers.close(), AggregateError);
  assert.equal((await f.inspect()).state, "stopped", "the later real process was still stopped");
  const afterStop = fold(f.daemon.store.readSince(0, project)).projects[project];
  assert.equal(
    afterStop?.sessions.find((s) => s.ticket === "SEED-2")?.phase,
    "released",
    "a confirmed stop durably frees launch capacity",
  );
  assert.equal(
    afterStop?.sessions.find((s) => s.ticket === "SEED-1")?.phase,
    "planning",
    "a failed stop retains its active generation",
  );
  assert(
    f.daemon.store
      .readSince(0, project)
      .some(
        (e) => e.kind === "session.runtime-observed" && e.payload.ticket === "SEED-2" && e.payload.state === "stopped",
      ),
  );
  assert.equal((await socketCall(f.socketPath, firstToken, { command: "claim", ticket: "SEED-1" })).status, 403);
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-2" })).status, 403);
});

test("a guard refusal before entering the launch provider cleans up the unused prepared workspace", {
  timeout: 15000,
}, async (t) => {
  let preparedPath = "";
  let changeOnce = true;
  const f = await fixture(t, (node) => ({
    ...node,
    async prepare(request) {
      const workspace = await node.prepare(request);
      preparedPath = workspace.path;
      // A tracker completion queued after prepare resolves but before the guarded native call.
      if (changeOnce) {
        changeOnce = false;
        queueMicrotask(() =>
          queueMicrotask(() => {
            f.daemon.store.append({
              project,
              at,
              actor: "tracker",
              kind: "ticket.seen",
              payload: {
                id: "SEED-1",
                title: "Completed",
                status: "completed",
                labels: ["backend-work", "ready-for-agent"],
              },
            });
          }),
        );
      }
      return workspace;
    },
  }));
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/guarded", brief: "hold" },
        f.api("guarded"),
        context,
      )
    ).isError,
    true,
  );
  assert.equal(f.token(), "", "the provider was never entered");
  await assert.rejects(stat(preparedPath), { code: "ENOENT" });
  f.daemon.store.append({
    project,
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: {
      id: "SEED-1",
      title: "Reopened",
      status: "unstarted",
      labels: ["backend-work", "ready-for-agent"],
      blockers: [],
    },
  });
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/after-guard", brief: "hold" },
        f.api("after-guard"),
        context,
      )
    ).isError,
    false,
  );
});

test("confirmed stop revokes its socket capability even when the following observation fails", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t, (node) => ({
    ...node,
    async observe(ref) {
      const observation = await node.observe(ref);
      if (observation.state === "stopped") throw new Error("Fixture observation unavailable");
      return observation;
    },
  }));
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/stop-observation", brief: "hold" },
        f.api("stop-observation-launch"),
        context,
      )
    ).isError,
    false,
  );
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 200);
  assert.equal(
    (await f.tools["worker.stop"].execute({ ticket: "SEED-1", reason: "Finished" }, f.api("stop-observation"), context))
      .isError,
    true,
  );
  assert.equal((await f.inspect()).state, "stopped", "the real process already stopped successfully");
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "heartbeat", ticket: "SEED-1" })).status, 403);
});

test("launch builds the ticket brief, uses plugin defaults and refuses unsafe fleet facts before spawning", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "AGENTS.md"), "Always preserve the orchard rows.");
  await writeFile(join(f.repository, "armada.toml"), '[brief]\nextra = "conventions.md"\n');
  await writeFile(join(f.repository, "conventions.md"), "Use only local seeds.");
  const original = fold(f.daemon.store.readSince(0, project)).projects[project]!.tickets[0]!;
  const run = (id: string) => f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api(id), context);
  const cases: [Partial<Ticket>, string][] = [
    [
      { description: "protected ticket".repeat(5000) },
      "The ticket and worker protocol cannot fit under 48 KiB; shorten the ticket before launching",
    ],
    [{ status: "completed" }, "SEED-1 is completed; there is nothing to launch"],
    [{ labels: ["backend"] }, "SEED-1 lacks ready-for-agent"],
    [{ labels: ["ready-for-agent", "parked"] }, "SEED-1 is parked; remove the parked label before launching"],
    [{ blockers: [{ id: "SEED-9", status: "started" }] }, "SEED-1 has open blockers; resolve them before launching"],
  ];
  for (const [change, message] of cases) {
    f.daemon.store.append({ project, at, actor: "tracker", kind: "ticket.seen", payload: { ...original, ...change } });
    const result = await run(message);
    assert.equal(result.isError, true);
    assert.equal((result.details as { message: string }).message, message);
    assert.equal(f.token(), "", "a refused preflight never enters the native launcher");
  }
  f.daemon.store.append({ project, at, actor: "tracker", kind: "ticket.seen", payload: original });
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: {
          revision: 2,
          value: { defaultRoute: { cli: "claude", model: "fixture", instructions: "Check the irrigation." } },
        },
        reason: "Defaults",
      },
    },
  });
  assert.equal((await run("default-launch")).isError, false);
  const claimed = f.daemon.store.readSince(0, project).filter((e) => e.kind === "session.claimed");
  assert.equal(claimed.length, 0, "launch and worker claim are distinct events");
  const launched = fold(f.daemon.store.readSince(0, project)).projects[project]!.sessions[0]!;
  assert.equal(launched.reason, "Launched; waiting for worker claim");
  assert.equal(launched.runtime, "claude");
  f.daemon.store.append({
    project,
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: { ...original, id: "SEED-2", branchName: "worker/seed-2" },
  });
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 3, value: { policy: { maxWorkers: 1 } } },
        reason: "Capacity",
      },
    },
  });
  const capped = await f.tools["worker.launch"].execute({ ticket: "SEED-2" }, f.api("cap"), context);
  assert.equal(
    (capped.details as { message: string }).message,
    "worker cap reached: 1 of 1 workers; nothing was launched",
  );
  assert.equal((await run("duplicate-launch")).isError, true);
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 200);
  assert.equal(f.daemon.store.readSince(0, project).filter((e) => e.kind === "session.claimed").length, 1);
  const reply = await f.workers.observe(project, "SEED-1");
  assert.equal(reply.state, "running");
  assert.match(f.messages[0]!, /Plant the orchard safely/);
  assert.match(f.messages[0]!, /Always preserve the orchard rows/);
  assert.match(f.messages[0]!, /Use only local seeds/);
  assert.match(f.messages[0]!, /Check the irrigation/);
  assert.match(f.messages[0]!, /## Worker protocol/);
  assert.match(f.messages[0]!, /armada claim SEED-1/);
  assert.match(f.messages[0]!, /Plans need the coordinator/);
  assert(!f.messages[0]!.includes(f.token()));
});

test("relaunch keeps branch/worktree changes, retires old capabilities and refuses stale generation actions", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.tools["worker.relaunch"].execute({ ticket: "SEED-1", reason: "Missing" }, f.api("missing"), context))
      .isError,
    true,
  );
  assert.equal((await f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api("launch"), context)).isError, false);
  const oldToken = f.token();
  const workspace = f.workspace();
  await writeFile(join(workspace, "in-progress.txt"), "Keep my work");
  const old = fold(f.daemon.store.readSince(0, project)).projects[project]!.sessions[0]!;
  const oldRef = { project, ticket: old.ticket, session: old.session, generation: old.generation, handle: old.handle };
  assert.equal((await socketCall(f.socketPath, oldToken, { command: "claim", ticket: "SEED-1" })).status, 200);
  const result = await f.tools["worker.relaunch"].execute(
    { ticket: "SEED-1", session: old.session, reason: "Recover idle worker" },
    f.api("replace"),
    context,
  );
  assert.equal(result.isError, false);
  const current = fold(f.daemon.store.readSince(0, project)).projects[project]!.sessions[0]!;
  assert.equal(current.generation, old.generation + 1);
  assert.notEqual(current.session, old.session);
  assert.equal(f.workspace(), workspace);
  assert.equal(await readFile(join(workspace, "in-progress.txt"), "utf8"), "Keep my work");
  assert.equal(
    execFileSync("git", ["-C", workspace, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    "worker/seed-1",
  );
  assert.equal(
    (
      await socketCall(f.socketPath, oldToken, {
        command: "report",
        ticket: "SEED-1",
        phase: "implementing",
        message: "late",
      })
    ).status,
    403,
  );
  await assert.rejects(
    f.workers.stop(oldRef, "Stale stop", () => {}),
    /generation/,
  );
  assert.equal(
    (
      await f.tools["worker.message"].execute(
        { ticket: "SEED-1", session: old.session, message: "stale" },
        f.api("stale"),
        context,
      )
    ).isError,
    true,
  );
  assert.equal(
    (
      await f.tools["worker.stop"].execute(
        { ticket: "SEED-1", session: old.session, reason: "stale" },
        f.api("stale-stop"),
        context,
      )
    ).isError,
    true,
  );
  assert.equal(
    (
      await f.tools["worker.relaunch"].execute(
        { ticket: "SEED-1", session: old.session, reason: "stale" },
        f.api("stale-replace"),
        context,
      )
    ).isError,
    true,
  );
  const before = f.daemon.store.sequence;
  assert.equal(
    (
      await f.tools["worker.relaunch"].execute(
        { ticket: "SEED-1", session: old.session, reason: "Recover idle worker" },
        f.api("replace"),
        context,
      )
    ).isError,
    false,
  );
  assert.equal(f.daemon.store.sequence, before, "replacement replay cannot stop the replacement");
  assert.equal(
    (await f.tools["worker.message"].execute({ ticket: "SEED-1", message: "finish" }, f.api("message"), context))
      .isError,
    false,
  );
  await until(f.workers, (value) => value.reply === "reply:finish");
  assert.equal(
    (await f.tools["worker.message"].execute({ ticket: "SEED-1", message: "different" }, f.api("message"), context))
      .isError,
    true,
  );
  const stopped = await f.tools["worker.stop"].execute({ ticket: "SEED-1", reason: "Done" }, f.api("stop"), context);
  assert.equal(stopped.isError, false);
  assert.equal((stopped.details as { disposed: boolean }).disposed, false);
  assert.equal(await readFile(join(workspace, "in-progress.txt"), "utf8"), "Keep my work");
  assert.equal((await socketCall(f.socketPath, f.token(), { command: "claim", ticket: "SEED-1" })).status, 403);
});

test("launch and relaunch require a confirmed fresh tracker read, while completed receipts replay without refreshing", {
  timeout: 15000,
}, async (t) => {
  let reading: string | undefined;
  let reads = 0;
  const instant = at;
  const f = await fixture(
    t,
    undefined,
    async (store) => {
      reads++;
      if (reading)
        store.append({
          project,
          kind: "coordinator.checkpoint",
          at: reading,
          actor: "reader",
          payload: { checkpoint: { format: "armada.readers", version: 1, provider: "linear" } },
        });
    },
    () => instant,
  );
  const launch = (key: string) => f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api(key), context);
  assert.equal((await launch("failed-refresh")).isError, true);
  assert.equal(f.token(), "");
  reading = "2029-12-31T23:59:00.000Z";
  assert.equal((await launch("stale-refresh")).isError, true);
  assert.equal(f.token(), "");
  reading = at;
  assert.equal((await launch("fresh-refresh")).isError, false);
  const token = f.token();
  reading = undefined;
  const before = reads;
  assert.equal((await launch("fresh-refresh")).isError, false);
  assert.equal(reads, before, "a committed launch receipt does not depend on reader availability");
  // Even at the same timestamp, a missing new successful checkpoint cannot authorize replacement.
  assert.equal(
    (
      await f.tools["worker.relaunch"].execute(
        { ticket: "SEED-1", reason: "Refresh unavailable" },
        f.api("replace"),
        context,
      )
    ).isError,
    true,
  );
  assert.equal(f.token(), token);
  assert.equal((await socketCall(f.socketPath, token, { command: "claim", ticket: "SEED-1" })).status, 200);
});

for (const approval of ["needs-plan-approval", "Review Required"]) {
  test(`${approval} wins over pre-approval in the bootstrapped brief`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const ticket = fold(f.daemon.store.readSince(0, project)).projects[project]?.tickets[0];
    assert(ticket);
    f.daemon.store.append({
      project,
      at,
      actor: "tracker",
      kind: "ticket.seen",
      payload: { ...ticket, labels: [...(ticket.labels ?? []), "plan-approved", approval] },
    });
    f.daemon.store.append({
      project,
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          reason: "Route backend before semantic choice",
          rules: {
            revision: 2,
            value: {
              routing: [{ labels: ["backend-work"], cli: "claude", model: "fixture" }],
              policy: {
                plans: "pre-approved",
                ...(approval === "Review Required" ? { approvalLabel: "review-required" } : {}),
              },
            },
          },
        },
      },
    });
    const result = await f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api("brief"), context);
    assert.equal(result.isError, false);
    assert.match(f.messages[0]!, /Plans need the coordinator's approval/);
    assert.match(f.messages[0]!, /npm install -g @the-vibe-company\/armada@0\.2\.67/);
    assert.match(f.messages[0]!, /armada skill armada-worker/);
    assert.match(f.messages[0]!, /npm exec --yes --package=@the-vibe-company\/armada@0\.2\.67 -- armada/);
    assert.match(f.messages[0]!, /Plans need the coordinator's approval/);
  });
}

test("a changed suggested branch refuses implicit launch but an explicit branch remains authoritative", {
  timeout: 15000,
}, async (t) => {
  let change = true;
  const f = await fixture(t, (node) => ({
    ...node,
    async prepare(request) {
      const workspace = await node.prepare(request);
      if (change) {
        change = false;
        const ticket = fold(f.daemon.store.readSince(0, project)).projects[project]?.tickets[0];
        assert(ticket);
        f.daemon.store.append({
          project,
          at,
          actor: "tracker",
          kind: "ticket.seen",
          payload: { ...ticket, branchName: "worker/changed-suggestion" },
        });
      }
      return workspace;
    },
  }));
  assert.equal(
    (await f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api("implicit"), context)).isError,
    true,
  );
  assert.equal(f.token(), "");
  assert.equal(
    (
      await f.tools["worker.launch"].execute(
        { ticket: "SEED-1", branch: "worker/explicit" },
        f.api("explicit"),
        context,
      )
    ).isError,
    false,
  );
  assert.equal(
    execFileSync("git", ["-C", f.workspace(), "branch", "--show-current"], { encoding: "utf8" }).trim(),
    "worker/explicit",
  );
});

test("launch scans label routes before asking for a semantic rule", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        reason: "Label precedence",
        rules: {
          revision: 2,
          value: {
            routing: [
              { when: "other work", cli: "codex", model: "unused" },
              { labels: ["backend-work"], cli: "claude", model: "fixture" },
            ],
          },
        },
      },
    },
  });
  const result = await f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api("mixed-routes"), context);
  assert.equal(result.isError, false);
  assert.equal((result.details as { runtime: string }).runtime, "claude");
});

test("confirmed merge cleanup stops and disposes the worker while retaining merged state", {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.tools["worker.launch"].execute({ ticket: "SEED-1" }, f.api("merge-launch"), context)).isError,
    false,
  );
  const token = f.token();
  assert.equal((await socketCall(f.socketPath, token, { command: "claim", ticket: "SEED-1" })).status, 200);
  const session = fold(f.daemon.store.readSince(0, project)).projects[project]?.sessions[0];
  assert(session);
  f.daemon.store.append({
    project,
    at,
    actor: "coordinator",
    kind: "merge.confirmed",
    payload: { id: "confirmed", ticket: "SEED-1", session: session.session, pr: 7, head: "a".repeat(40) },
  });
  assert.equal(fold(f.daemon.store.readSince(0, project)).projects[project]?.sessions[0]?.phase, "merged");
  const stopped = await f.tools["worker.stop"].execute(
    { ticket: "SEED-1", session: session.session, reason: "Pull request merged" },
    f.api("merge-stop"),
    context,
  );
  assert.equal(stopped.isError, false);
  assert.equal((stopped.details as { disposed: boolean }).disposed, true);
  assert.equal(fold(f.daemon.store.readSince(0, project)).projects[project]?.sessions[0]?.phase, "merged");
  await assert.rejects(stat(f.workspace()), { code: "ENOENT" });
  assert.equal((await socketCall(f.socketPath, token, { command: "heartbeat", ticket: "SEED-1" })).status, 403);
});
