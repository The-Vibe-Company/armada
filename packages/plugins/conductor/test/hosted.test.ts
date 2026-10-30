import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { armadaApi, machinePaths, updateCredentialStore } from "@armada/core/account";
import { manifestSchema } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { ARMADA_URL, fakeArmada, fakeClock } from "../../../core/test/support.node.js";
import { importV1Rules } from "../../../daemon/coordinator/rules-import.ts";
import { fold } from "../../../daemon/src/fold.ts";
import { PluginRegistry } from "../../../daemon/src/plugins/registry.ts";
import { Account } from "../../../daemon/src/server/account.ts";
import { EventStore } from "../../../daemon/src/store.ts";
import { HostedReader, startHostedReader } from "../../../daemon/src/workers/hosted.ts";
import { WorkerRefusal, Workers } from "../../../daemon/src/workers/service.ts";
import { conductorRuntime } from "../src/index.ts";

const at = "2030-01-01T00:00:00.000Z";
const project = {
  id: "orchard",
  name: "Orchard",
  repository: "example/orchard",
  programRoot: "SEED-100",
};
async function setup(t: TestContext, signedIn = true) {
  const directory = await mkdtemp(join(tmpdir(), "armada-conductor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "conductor");
  await copyFile(new URL("./fixtures/conductor-worker.mjs", import.meta.url), binary);
  await writeFile(join(directory, "state.json"), JSON.stringify({ calls: [], status: "idle" }));
  // An executable script is the real runtime boundary, not an injected implementation.
  const { chmod } = await import("node:fs/promises");
  await chmod(binary, 0o755);
  const fake = fakeArmada({
    clock: fakeClock(new Date(at)),
    token: randomBytes(24).toString("hex"),
    vault: { linear: { apiKey: randomBytes(24).toString("hex"), scope: "organization" }, now: () => new Date(at) },
  });
  const session = randomBytes(24).toString("hex");
  fake.sessions.add(session);
  const env = { XDG_CONFIG_HOME: directory, ARMADA_API_URL: ARMADA_URL };
  const paths = machinePaths(env);
  assert.ok(paths);
  if (signedIn) await updateCredentialStore(paths, { ARMADA_SESSION_TOKEN: session, ARMADA_SIGNED_IN_TO: ARMADA_URL });
  const log: string[] = [];
  const transport = { fetch: fake.fetch };
  const account = new Account({
    env,
    fetch: (url, init) => transport.fetch(url, init),
    now: () => new Date(at),
    log: (line) => log.push(line),
  });
  t.after(() => account.close());
  const runtime = conductorRuntime({
    binary,
    profiles: {
      opus: { agent: "claude", model: "fixture-opus", effort: "high" },
      codex: { agent: "codex", model: "fixture-codex", effort: "high" },
    },
    routing: [
      { labels: ["web"], profile: "opus" },
      { labels: ["api"], profile: "codex" },
    ],
    defaultProfile: "codex",
  });
  const registry = new PluginRegistry();
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).armada,
  );
  const activation = registry.activation(manifest);
  activation.register.runtime("conductor", runtime);
  activation.commit();
  const store = new EventStore(join(directory, "events.sqlite"));
  t.after(() => store.close());
  store.append({
    project: project.id,
    at,
    actor: "tracker",
    kind: "ticket.seen",
    payload: {
      id: "SEED-1",
      title: "Plant",
      labels: ["web", "ready-for-agent"],
      status: "unstarted",
      blockers: [],
      branchName: "worker/seed-1",
    },
  });
  store.append({
    project: project.id,
    at,
    actor: "coordinator",
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.tools",
        version: 1,
        type: "rules",
        rules: { revision: 1, value: { routing: [{ labels: ["web"], cli: "conductor", model: "opus" }] } },
      },
    },
  });
  const makeWorkers = (refresh?: (project: string) => Promise<void>) =>
    new Workers({
      store,
      registry,
      projects: [project],
      account,
      socketPath: "/unused/socket",
      now: () => new Date(Date.parse(at) + 60_000).toISOString(),
      refresh,
    });
  const workers = makeWorkers();
  const state = async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  return { workers, makeWorkers, store, account, fake, state, directory, runtime, log, transport, binary };
}

test("hosted launch sends login only through stdin, uses label profile, and masks all observable results", async (t) => {
  const f = await setup(t);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const state = await f.state();
  const login = /^armada login --launch-token (\S+) --api-url (\S+)/.exec(state.brief);
  assert.ok(login, "the brief must begin with the hosted login command");
  assert.equal(login[2], ARMADA_URL);
  assert.equal(state.calls[0].args.includes("fixture-opus"), true);
  assert.equal(state.calls[0].args.includes("https://github.com/example/orchard"), true);
  assert.equal(state.calls[0].args.includes(login[1]), false);
  assert.equal(state.brief.includes("ARMADA_WORKER_SOCKET"), false);
  assert.equal(state.brief.includes("--profile"), false, "desktop profile names do not need matching V1 CLI profiles");
  assert.ok(state.brief.includes("project.slug matches"));
  assert.equal(state.brief.includes("armada claim SEED-1 --runtime conductor"), true);
  const visible = JSON.stringify([
    launched,
    f.store.readSince(0),
    f.log,
    await f.workers.observe(project.id, "SEED-1"),
  ]);
  assert.equal(visible.includes(login[1]!), false);
  const api = armadaApi({ url: ARMADA_URL, fetch: f.fake.fetch });
  const exchanged = await api.exchangeLaunchToken(login[1]!);
  const claimed = await api.fleet(
    { kind: "worker", token: exchanged.token, ticket: "SEED-1", project: project.id },
    "claim",
    {
      project: {
        slug: project.id,
        name: project.name,
        repository: project.repository,
        programRoot: project.programRoot,
      },
      input: {
        ticket: "SEED-1",
        runtime: "conductor",
        handle: launched.handle,
        branch: "worker/seed-1",
        profile: null,
        resuming: false,
      },
    },
  );
  assert.ok(claimed, "the first hosted worker claim is authorized");
  await assert.rejects(api.exchangeLaunchToken(login[1]!));
});

for (const signIn of ["absent", "expired"] as const)
  test(`Conductor ${signIn} sign-in refuses before refresh, token minting or workspace creation`, async (t) => {
    const f = await setup(t, signIn !== "absent");
    if (signIn === "expired") {
      await f.account.refresh();
      f.fake.sessions.clear();
    }
    let refreshed = false;
    const workers = f.makeWorkers(async () => {
      refreshed = true;
      throw new Error("Tracker unavailable");
    });
    await assert.rejects(
      workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}),
      (error: unknown) =>
        error instanceof WorkerRefusal && error.message === "Sign in to Armada in Settings to launch in Conductor",
    );
    assert.equal(refreshed, false);
    assert.equal((await f.state()).calls.length, 0);
    assert.equal(
      f.fake.calls.some((call) => call.path === "launch-tokens"),
      false,
    );
    assert.equal(
      f.store
        .readSince(0)
        .some(
          (event) => event.kind === "coordinator.checkpoint" && JSON.stringify(event.payload).includes("launch-intent"),
        ),
      false,
    );
  });

test("runtime rechecks generation and session provenance before delivery, cancellation and archive", async (t) => {
  const f = await setup(t);
  await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const row = fold(f.store.readSince(0)).projects[project.id]!.sessions[0]!;
  const ref = {
    project: project.id,
    ticket: row.ticket,
    session: row.session,
    generation: row.generation,
    handle: row.handle,
  };
  await f.workers.tool(project.id, "worker.message", { ticket: "SEED-1", message: "Continue" }, "message", () => {});
  await assert.rejects(f.runtime.deliver(ref, "unguarded", "forbidden"), /guard/);
  const state = await f.state();
  state.mismatch = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    guarded(
      ref,
      () => {},
      () => f.runtime.stop(ref),
    ),
    /match/,
  );
  assert.equal(
    (await f.state()).calls.some((call: { args: string[] }) => call.args[1] === "cancel"),
    false,
  );
  state.mismatch = false;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await f.workers.tool(project.id, "worker.stop", { ticket: "SEED-1", reason: "Finished" }, "stop", () => {});
  assert.equal((await f.state()).archived, true);
});

async function remoteWorker(f: Awaited<ReturnType<typeof setup>>, handle: unknown) {
  const login = /^armada login --launch-token (\S+)/.exec((await f.state()).brief)!;
  const api = armadaApi({ url: ARMADA_URL, fetch: f.fake.fetch });
  const worker = await api.exchangeLaunchToken(login[1]!);
  const descriptor = {
    slug: project.id,
    name: project.name,
    repository: project.repository,
    programRoot: project.programRoot,
  };
  const call = async (op: string, input: object) => {
    f.fake.clock.advance(1000);
    return api.fleet({ kind: "worker", token: worker.token, ticket: "SEED-1", project: project.id }, op, {
      project: descriptor,
      input: { ticket: "SEED-1", ...input },
    });
  };
  await call("claim", { runtime: "conductor", handle, branch: "worker/seed-1", profile: null, resuming: false });
  return call;
}

test("hosted polls fold reports, questions and hand-back once across restart, fence a replacement and import release", async (t) => {
  const f = await setup(t);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const call = await remoteWorker(f, launched.handle);
  const options = { store: f.store, account: f.account, projects: [project], now: () => at };
  const reader = new HostedReader(options);
  await call("report", { phase: "implementing", previous: "planning", summary: "Planting", message: "Planting" });
  await call("heartbeat", { handle: launched.handle });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]!.sessions[0]!.phase, "implementing");
  assert.equal(
    fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.heartbeat,
    f.fake.clock.now().toISOString(),
  );
  await call("ask", { body: "Choose the seeds" });
  await reader.poll();
  const question = fold(f.store.readSince(0)).projects[project.id]!.inbox[0]!;
  assert.equal(question.kind, "question");
  await f.workers.answer(
    {
      key: "answer",
      item: question.id,
      session: { ticket: "SEED-1", session: String(launched.session) },
      answer: "Use apples",
      beforeWrite: () => {},
    },
    project.id,
  );
  assert.equal(f.fake.store.items.find((item) => item.kind === "question")?.resolution, "Use apples");
  await call("report", {
    phase: "ready-to-merge",
    previous: "implementing",
    summary: "PR #17, head " + "a".repeat(40),
    message: "Ready",
    prUrl: "https://github.com/example/orchard/pull/17",
    headSha: "a".repeat(40),
  });
  await reader.poll();
  await f.workers.close();
  assert.equal((await f.state()).archived, undefined, "closing the daemon preserves a hosted workspace");
  const resumed = f.makeWorkers();
  assert.equal((await resumed.observe(project.id, "SEED-1")).state, "running");
  const reopened = new EventStore(join(f.directory, "events.sqlite"));
  t.after(() => reopened.close());
  const restored = new HostedReader({ ...options, store: reopened });
  await Promise.all([restored.poll(), restored.poll()]);
  const handbacks = reopened
    .readSince(0)
    .filter((event) => event.kind === "inbox.opened" && event.payload.kind === "hand-back");
  assert.equal(handbacks.length, 1);
  assert.equal(fold(reopened.readSince(0)).projects[project.id]!.sessions[0]!.phase, "ready-to-merge");
  assert.equal(
    fold(reopened.readSince(0)).projects[project.id]?.inbox.some((item) => item.kind === "question"),
    false,
  );
  await call("report", {
    phase: "ready-to-merge",
    previous: "ready-to-merge",
    summary: `PR #17, head ${"b".repeat(40)}`,
    message: "Revised head",
    prUrl: "https://github.com/example/orchard/pull/17",
    headSha: "b".repeat(40),
  });
  await restored.poll();
  await restored.poll();
  const revised = fold(reopened.readSince(0)).projects[project.id]?.inbox.filter((item) => item.kind === "hand-back");
  assert.equal(revised?.length, 1);
  assert.ok(revised?.[0]?.body.includes("b".repeat(40)));
  assert.equal(
    reopened.readSince(0).filter((event) => event.kind === "inbox.opened" && event.payload.kind === "hand-back").length,
    2,
  );
  await call("release", { reason: "Finished", handle: launched.handle });
  await restored.poll();
  assert.equal(fold(reopened.readSince(0)).projects[project.id]!.sessions[0]!.phase, "released");
  f.store.append({
    project: project.id,
    at,
    actor: "coordinator",
    kind: "session.claimed",
    payload: {
      ticket: "SEED-1",
      session: "replacement",
      generation: 2,
      runtime: "conductor",
      handle: "other/session",
      owner: "coordinator",
    },
  });
  const sequence = reopened.sequence;
  await restored.poll();
  assert.equal(reopened.sequence, sequence);
  assert.equal(fold(reopened.readSince(0)).projects[project.id]!.sessions[0]!.phase, "planning");
});

test("hosted scheduling waits 15 seconds, shares an in-flight read, and stops after shutdown", async (t) => {
  const f = await setup(t);
  const tasks: { callback: () => void; milliseconds: number; cancelled: boolean }[] = [];
  const polling = startHostedReader({
    store: f.store,
    account: f.account,
    projects: [project],
    schedule: (callback, milliseconds) => {
      const task = { callback, milliseconds, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  assert.equal(tasks.length, 0);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  await remoteWorker(f, launched.handle);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.milliseconds, 15_000);
  const first = polling.reader.poll();
  const second = polling.reader.poll();
  assert.equal(first, second);
  await first;
  await polling.stop();
  const calls = f.fake.calls.length;
  tasks[0]!.callback();
  await polling.reader.poll();
  assert.equal(f.fake.calls.length, calls);
});

for (const mode of ["diagnostic", "metadata", "metadata-suffix"] as const)
  test(`unknown Conductor creation (${mode}) never repeats or discloses the login token`, async (t) => {
    const f = await setup(t);
    const state = await f.state();
    state.failCreate = mode === "diagnostic";
    state.echoCreateToken = mode !== "diagnostic";
    state.tokenPrefix = mode === "metadata-suffix" ? "workspace_" : "";
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const failure = await f.workers
      .tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {})
      .then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
    assert.match(failure, /inspect the workspace before retrying/);
    const token = /^armada login --launch-token (\S+)/.exec((await f.state()).brief)?.[1];
    assert.ok(token);
    assert.equal(JSON.stringify([failure, f.store.readSince(0), f.log]).includes(token), false);
    await assert.rejects(
      f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}),
      /outcome unknown/,
    );
    assert.equal((await f.state()).calls.filter((call: { args: string[] }) => call.args[1] === "create").length, 1);
    await f.workers.recoverHosted(project.id);
    const recovered = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
    assert.equal(recovered.recovered, true);
    assert.equal(
      (await f.state()).calls.filter(
        (call: { args: string[] }) => call.args[0] === "workspace" && call.args[1] === "create",
      ).length,
      1,
    );
  });

test("project TOML imports hosted label routes while retaining the project's gates and policy", () => {
  const rules = importV1Rules(`
[policy]
plans = "approve"
max_workers = 2
[gates]
required_checks = ["test"]
[herdr.profiles.local]
harness = "codex"
[plugins.conductor]
binary = "/Applications/Conductor.app/conductor"
defaultProfile = "api"
[plugins.conductor.profiles.web]
agent = "claude"
model = "fixture-opus"
effort = "high"
[plugins.conductor.profiles.api]
agent = "codex"
model = "fixture-codex"
effort = "high"
[[plugins.conductor.routing]]
labels = ["web"]
profile = "web"
[[plugins.conductor.routing]]
labels = ["api"]
profile = "api"
`);
  assert.deepEqual(rules.routing, [
    { labels: ["web"], cli: "conductor", model: "web", effort: "high" },
    { labels: ["api"], cli: "conductor", model: "api", effort: "high" },
  ]);
  assert.deepEqual(rules.defaultRoute, { cli: "conductor", model: "api", effort: "high" });
  assert.deepEqual(rules.gates?.requiredChecks, ["test"]);
  assert.equal(rules.policy?.plans, "approve");
  assert.equal(rules.policy?.maxWorkers, 2);
});

test("room observations share a slow native read and the background observer stays single-flight", async (t) => {
  const f = await setup(t);
  await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  f.runtime.observe = async () => {
    reads++;
    await pending;
    return { state: "running", activity: "idle" };
  };
  const first = f.workers.observe(project.id, "SEED-1");
  const second = f.workers.observe(project.id, "SEED-1");
  const background = f.workers.observeAll();
  assert.equal(background, f.workers.observeAll());
  assert.equal(reads, 1);
  release();
  const observed = await Promise.all([first, second, background]);
  assert.equal(observed[0]?.state, "running");
  assert.equal(observed[1]?.activity, "idle");
});

for (const status of ["starting", "queued"] as const)
  test(`stop cancels and archives a ${status} Conductor worker`, async (t) => {
    const f = await setup(t);
    await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
    const state = await f.state();
    state.status = status;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    assert.equal((await f.workers.observe(project.id, "SEED-1")).state, "starting");
    await f.workers.tool(
      project.id,
      "worker.stop",
      { ticket: "SEED-1", reason: "Stop pending turn" },
      "stop",
      () => {},
    );
    const stopped = await f.state();
    assert.ok(
      stopped.calls.some((call: { args: string[] }) => call.args[0] === "session" && call.args[1] === "cancel"),
    );
    assert.equal(stopped.archived, true);
  });

test("an unavailable binary revokes its exact launch, completes the failed intent and allows a corrected launch", async (t) => {
  const f = await setup(t);
  await rm(f.binary);
  await assert.rejects(f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "bad-binary", () => {}));
  assert.ok(f.fake.store.launches[0]?.endedAt);
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "released");
  await copyFile(new URL("./fixtures/conductor-worker.mjs", import.meta.url), f.binary);
  const { chmod } = await import("node:fs/promises");
  await chmod(f.binary, 0o755);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "fixed-binary", () => {});
  assert.equal(launched.ok, true);
  assert.equal((await f.state()).calls.filter((call: { args: string[] }) => call.args[1] === "create").length, 1);
});

for (const interruption of ["token-response", "launch-id-write"] as const)
  test(`a ${interruption} interruption preserves intent across restart without another mint or native create`, async (t) => {
    const f = await setup(t);
    const fetch = f.transport.fetch;
    let hadIntent = false;
    f.transport.fetch = async (url, init) => {
      if (url.endsWith("/launch-tokens")) {
        hadIntent = f.store
          .readSince(0)
          .some(
            (event) =>
              event.kind === "coordinator.checkpoint" && JSON.stringify(event.payload).includes("launch-intent"),
          );
        const response = await fetch(url, init);
        if (interruption === "token-response") throw new Error("Simulated lost response");
        return response;
      }
      return fetch(url, init);
    };
    const append = f.store.append.bind(f.store);
    if (interruption === "launch-id-write")
      f.store.append = (event) => {
        const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
        if (c && typeof c === "object" && !Array.isArray(c) && c.type === "launch-intent" && c.launchId)
          throw new Error("Simulated interrupted checkpoint");
        return append(event);
      };
    await assert.rejects(f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}));
    f.store.append = append;
    assert.equal(hadIntent, true);
    const restarted = f.makeWorkers();
    await assert.rejects(
      restarted.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}),
      /outcome unknown/,
    );
    await assert.rejects(
      restarted.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "another-launch", () => {}),
      /unresolved launch intent/,
    );
    assert.equal(f.fake.calls.filter((call) => call.path === "launch-tokens").length, 1);
    assert.equal((await f.state()).calls.length, 0);
  });

test("a native create recovered after restart is proven by its unique name and never repeated", async (t) => {
  const f = await setup(t);
  const launch = f.runtime.launch.bind(f.runtime);
  f.runtime.launch = async (request) => {
    await launch(request);
    throw new Error("Native result lost");
  };
  await assert.rejects(
    f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}),
    /Native result lost/,
  );
  const restarted = f.makeWorkers();
  const reader = new HostedReader({
    store: f.store,
    account: f.account,
    projects: [project],
    recover: (project) => restarted.recoverHosted(project),
  });
  assert.equal(reader.hasWork(), true);
  // A renamed/ambiguous candidate is retained, never adopted from a worker-supplied handle.
  const state = await f.state();
  const name = state.sessionName;
  state.sessionName = "Someone else's session";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await reader.poll();
  assert.equal(
    f.fake.calls.some((call) => call.path === "launch-tokens/bind"),
    false,
  );
  state.sessionName = name;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await reader.poll();
  const recovered = await restarted.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  assert.equal(recovered.recovered, true);
  const call = await remoteWorker(f, recovered.handle);
  await call("report", { phase: "implementing", previous: "planning", summary: "Recovered", message: "Recovered" });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "implementing");
  assert.equal(
    (await f.state()).calls.filter(
      (call: { args: string[] }) => call.args[0] === "workspace" && call.args[1] === "create",
    ).length,
    1,
  );
});

test("bind failure after token exchange releases the exact claimed worker session", async (t) => {
  const f = await setup(t);
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, init) => {
    if (url.endsWith("/launch-tokens/bind")) {
      await remoteWorker(f, JSON.parse(String(init.body)).handle);
      return Response.json({ error: "Synthetic bind refusal" }, { status: 409 });
    }
    return fetch(url, init);
  };
  await assert.rejects(
    f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {}),
    /could not bind/,
  );
  assert.equal(f.fake.workers.size, 1);
  assert.ok([...f.fake.workers.values()].every((worker) => worker.ended));
  assert.ok((await f.fake.store.getRuntimeHandle(project.id, "SEED-1"))?.releasedAt);
});

for (const terminal of ["merge", "closed-handle", "malformed-merge"] as const)
  test(`hosted ${terminal} closes the local generation without a release event`, async (t) => {
    const f = await setup(t);
    const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
    await remoteWorker(f, launched.handle);
    const reader = new HostedReader({ store: f.store, account: f.account, projects: [project] });
    await reader.poll();
    const held = await f.fake.store.getRuntimeHandle(project.id, "SEED-1");
    assert.ok(held);
    f.fake.clock.advance(1000);
    if (terminal !== "closed-handle")
      await f.fake.store.recordEvent({
        project: project.id,
        ticket: "SEED-1",
        kind: "merge",
        prUrl: terminal === "malformed-merge" ? "not a URL" : "https://github.com/example/orchard/pull/17",
        headSha: "a".repeat(40),
        at: f.fake.clock.now(),
      });
    await f.fake.store.releaseRuntimeHandle(
      project.id,
      "SEED-1",
      f.fake.clock.now(),
      { handle: held.handle, claimedAt: held.claimedAt, workerSessionId: held.workerSessionId },
      terminal === "merge",
    );
    await reader.poll();
    assert.equal(
      fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase,
      terminal === "merge" ? "merged" : "released",
    );
    assert.equal(reader.hasWork(), false);
    const calls = f.fake.calls.length;
    await reader.poll();
    assert.equal(f.fake.calls.length, calls);
  });

test("claim event identity accepts skewed current reports and excludes reports from an older generation", async (t) => {
  const f = await setup(t);
  await f.fake.store.recordEvent({
    project: project.id,
    ticket: "SEED-1",
    kind: "report",
    phase: "blocked",
    message: "Old generation",
    at: new Date(Date.parse(at) - 1000),
  });
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const call = await remoteWorker(f, launched.handle);
  f.fake.clock.advance(-5000);
  await call("report", {
    phase: "implementing",
    previous: "planning",
    summary: "Current generation",
    message: "Current generation",
  });
  const reader = new HostedReader({ store: f.store, account: f.account, projects: [project] });
  await reader.poll();
  const session = fold(f.store.readSince(0)).projects[project.id]?.sessions[0];
  assert.equal(session?.phase, "implementing");
  assert.equal(session?.reason, "Current generation");
  assert.equal(
    f.store
      .readSince(0)
      .some((event) => event.kind === "session.reported" && event.payload.reason === "Old generation"),
    false,
  );
});

test("merge cleanup records the hosted worker's merged terminal reason", async (t) => {
  const f = await setup(t);
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith("/fleet/release") && response.ok) f.fake.end("SEED-1", "released");
    return response;
  };
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  await remoteWorker(f, launched.handle);
  f.store.append({
    project: project.id,
    actor: "coordinator",
    at,
    kind: "merge.confirmed",
    payload: { id: "merged", ticket: "SEED-1", session: String(launched.session), pr: 17, head: "a".repeat(40) },
  });
  await f.workers.tool(
    project.id,
    "worker.stop",
    { ticket: "SEED-1", reason: "Pull request merged" },
    "stop-merged",
    () => {},
  );
  const ended = f.fake.calls.find((call) => call.path === "workers/end");
  assert.ok(ended?.body && typeof ended.body === "object" && "reason" in ended.body);
  assert.equal(ended.body.reason, "merged");
  assert.match(
    String([...f.fake.workers.values()][0]?.ended),
    /merged/,
    "release must not win the terminal-reason race",
  );
});

test("Conductor routing accepts the Cursor agent advertised by the provider", () => {
  const rules = importV1Rules(
    '[plugins.conductor]\ndefaultProfile = "cursor"\n[plugins.conductor.profiles.cursor]\nagent = "cursor"\nmodel = "fixture"\neffort = "high"\n',
  );
  assert.equal(rules.defaultRoute?.cli, "conductor");
  assert.equal(rules.defaultRoute?.model, "cursor");
});

test("a current inbox action supplies phase when only an older implementing report is available", async (t) => {
  const f = await setup(t);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const call = await remoteWorker(f, launched.handle);
  await call("report", {
    phase: "implementing",
    previous: "planning",
    summary: "Implementing",
    message: "Implementing",
  });
  const reader = new HostedReader({ store: f.store, account: f.account, projects: [project] });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "implementing");
  await call("report", {
    phase: "ready-to-merge",
    previous: "implementing",
    summary: "Current hand-back",
    message: "Current hand-back",
    prUrl: "https://github.com/example/orchard/pull/17",
    headSha: "a".repeat(40),
  });
  const fetch = f.transport.fetch;
  f.transport.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith("/fleet/events/since") || response.status !== 200) return response;
    const body = await response.clone().json();
    if (body.result?.events)
      body.result.events = body.result.events.filter((event: { phase: string }) => event.phase !== "ready-to-merge");
    return Response.json(body, { headers: response.headers });
  };
  await reader.poll();
  const tables = fold(f.store.readSince(0)).projects[project.id];
  assert.equal(tables?.inbox.find((item) => item.kind === "hand-back")?.body.includes("Current hand-back"), true);
  assert.equal(tables?.sessions[0]?.phase, "ready-to-merge");
});

test("a report delayed across replacement retains its original handle and cannot change the new generation", async (t) => {
  const f = await setup(t);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const call = await remoteWorker(f, launched.handle);
  let resume!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const savePaths = f.fake.store.saveTicketPaths.bind(f.fake.store);
  f.fake.store.saveTicketPaths = async (...args) => {
    entered();
    await waiting;
    return savePaths(...args);
  };
  const delayed = call("report", {
    phase: "blocked",
    previous: "planning",
    summary: "Old delayed report",
    message: "Old delayed report",
    paths: ["old.ts"],
  });
  await started;
  await call("release", { reason: "Replaced", handle: launched.handle });
  const token = await f.account.launchWorkerToken(project.id, "SEED-1");
  const api = armadaApi({ url: ARMADA_URL, fetch: f.fake.fetch });
  const worker = await api.exchangeLaunchToken(token.token);
  f.fake.clock.advance(1000);
  await api.fleet({ kind: "worker", token: worker.token, ticket: "SEED-1", project: project.id }, "claim", {
    project: { slug: project.id, name: project.name, repository: project.repository, programRoot: project.programRoot },
    input: {
      ticket: "SEED-1",
      runtime: "conductor",
      handle: "replacement-ws/replacement-session",
      branch: "worker/seed-1",
      profile: null,
      resuming: false,
    },
  });
  f.store.append({
    project: project.id,
    actor: "coordinator",
    at: f.fake.clock.now().toISOString(),
    kind: "coordinator.checkpoint",
    payload: {
      checkpoint: {
        format: "armada.worker",
        version: 1,
        type: "launch",
        hosted: true,
        launchId: worker.worker.id,
        ticket: "SEED-1",
        session: "replacement-local",
        generation: 2,
        runtime: "conductor",
        branch: "worker/seed-1",
        handle: "replacement-ws/replacement-session",
        step: "launched",
      },
    },
  });
  f.fake.store.saveTicketPaths = savePaths;
  await api.fleet({ kind: "worker", token: worker.token, ticket: "SEED-1", project: project.id }, "report", {
    project: { slug: project.id, name: project.name, repository: project.repository, programRoot: project.programRoot },
    input: {
      ticket: "SEED-1",
      phase: "awaiting-approval",
      previous: "planning",
      summary: "Replacement plan",
      message: "Replacement plan",
      paths: ["replacement.ts"],
    },
  });
  resume();
  await delayed;
  assert.deepEqual((await f.fake.store.ticketPaths(project.id))["SEED-1"], ["replacement.ts"]);
  const replacementPlan = (
    await f.fake.store.openInboxItems({ project: project.id, recipient: "coordinator", ticket: "SEED-1" })
  ).find((item) => item.kind === "plan");
  assert.match(replacementPlan?.body ?? "", /^Replacement plan(?:\n|$)/);
  const old = f.fake.store.events.find((event) => event.kind === "report" && event.message === "Old delayed report");
  assert.equal(old?.handle, launched.handle, "the producer must retain the pre-replacement identity");
  const reader = new HostedReader({ store: f.store, account: f.account, projects: [project] });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.session, "replacement-local");
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "awaiting-approval");
  // Legacy rows without a captured identity cannot be safely attributed, even after the new claim id.
  await f.fake.store.recordEvent({
    project: project.id,
    ticket: "SEED-1",
    kind: "report",
    phase: "blocked",
    message: "Unverified legacy report",
    at: f.fake.clock.now(),
  });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "awaiting-approval");
});

test("a delayed older report cannot override a hand-back imported by an earlier poll", async (t) => {
  const f = await setup(t);
  const launched = await f.workers.tool(project.id, "worker.launch", { ticket: "SEED-1" }, "launch", () => {});
  const call = await remoteWorker(f, launched.handle);
  await call("report", {
    phase: "implementing",
    previous: "planning",
    summary: "Older report",
    message: "Older report",
  });
  f.fake.clock.advance(1000);
  await call("report", {
    phase: "ready-to-merge",
    previous: "implementing",
    summary: "Current hand-back",
    message: "Current hand-back",
    prUrl: "https://github.com/example/orchard/pull/17",
    headSha: "a".repeat(40),
  });
  const fetch = f.transport.fetch;
  let allowOlder = false;
  f.transport.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith("/fleet/events/since") || response.status !== 200) return response;
    const body = await response.clone().json();
    if (body.result?.events)
      body.result.events = body.result.events.filter(
        (event: { kind: string; phase: string }) =>
          event.kind !== "report" || (allowOlder && event.phase === "implementing"),
      );
    return Response.json(body, { headers: response.headers });
  };
  const reader = new HostedReader({ store: f.store, account: f.account, projects: [project] });
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "ready-to-merge");
  allowOlder = true;
  await reader.poll();
  assert.equal(fold(f.store.readSince(0)).projects[project.id]?.sessions[0]?.phase, "ready-to-merge");
});
