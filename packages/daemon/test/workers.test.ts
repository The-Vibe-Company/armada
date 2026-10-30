import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { NodeProvider, WorkerObservation, WorkerRef } from "@armada/plugin-api";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { activate as activateClaude } from "../../plugins/claude/src/index.ts";
import { createLocalNode } from "../../plugins/node-local/src/index.ts";
import { nativeTools } from "../coordinator/native.ts";
import { openCoordinatorStorage } from "../coordinator/storage.ts";
import { bootDaemon } from "../src/boot.ts";
import { fold } from "../src/fold.ts";
import { Workers } from "../src/workers/service.ts";
import { startWorkerSocket } from "../src/workers/socket.ts";

const at = "2030-01-01T00:00:00.000Z";
const project = "orchard";
async function until(workers: Workers, expected: (value: WorkerObservation) => boolean) {
  while (true) {
    const observation = await workers.observe(project, "SEED-1");
    if (expected(observation)) return observation;
    await setImmediate(); // Yield to actual process I/O; no wall-clock sleep or time-based assertion.
  }
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
async function fixture(t: TestContext, wrap?: (node: NodeProvider) => NodeProvider) {
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
              async launch(request) {
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
    payload: { id: "SEED-1", title: "Plant", labels: ["Ｂackend Work"], status: "unstarted" },
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
    now: () => at,
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
  return { daemon, workers, socketPath, token: () => token, tools, api, inspect: () => local.observe(reference) };
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

for (const change of [{ status: "canceled" as const }, { labels: ["frontend"] }]) {
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
    payload: { id: "SEED-2", title: "Second", labels: ["backend-work"], status: "unstarted" },
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
                labels: ["backend-work"],
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
    payload: { id: "SEED-1", title: "Reopened", status: "unstarted", labels: ["backend-work"] },
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
