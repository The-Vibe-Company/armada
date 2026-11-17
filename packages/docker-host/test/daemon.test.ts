import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapDescriptor } from "../../core/src/docker-host-job.ts";
import { createDockerMachineExecutor, DockerMachineError } from "../../core/src/docker-machine.ts";
import {
  type Api,
  compactReceipts,
  createPhysicalExpirySweep,
  type Executor,
  type Job,
  register,
  runJobs,
  type State,
  type Store,
  tick,
} from "../src/daemon.ts";
import { fileStore, httpApi } from "../src/native.ts";

function fail(): never {
  throw new Error("missing receipt");
}

function fixture(
  operation: Exclude<Job["operation"], "bootstrap" | "resume" | "buildSnapshot"> = "create",
  bootstrap?: BootstrapDescriptor,
) {
  const job: Job = {
    requestId: crypto.randomUUID(),
    ...(bootstrap ? { operation: "bootstrap" as const, bootstrap } : { operation }),
    request: {
      sandboxId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      image: `debian@sha256:${"a".repeat(64)}`,
      ttlSeconds: 60,
    },
  };
  let state: State = {
    server: "https://armada.example",
    installationId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    hostToken: randomBytes(32).toString("hex"),
    receipts: [],
  };
  let deny = false;
  let failSave = false;
  let failure: false | Error = false;
  const executed: string[] = [];
  const swept: string[] = [];
  const acknowledgements: string[] = [];
  const store: Store = {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      if (failSave) throw new Error("disk unavailable");
      state = structuredClone(next);
    },
  };
  const run = async () => {
    // Receipt comes from the actual store write, not a fixture-supplied pending record.
    expect(state.receipts.some((r) => r.requestId === job.requestId && !r.outcome)).toBe(true);
    executed.push(job.operation);
    if (failure) throw failure;
  };
  const executor: Executor = {
    startRuntime: run,
    create: run,
    stop: run,
    delete: run,
    async stopIfExpired(request) {
      swept.push(request.generation);
    },
  };
  const api: Api = {
    async register() {
      throw new Error("unused");
    },
    async poll() {
      if (deny) throw new Error("denied");
      return { job: structuredClone(job) };
    },
    async result(_state, receipt) {
      expect(state.receipts.find((r) => r.requestId === receipt.requestId)?.outcome).toBe(receipt.outcome);
      acknowledgements.push(receipt.outcome ?? "missing");
    },
  };
  return {
    job,
    store,
    executor,
    api,
    executed,
    swept,
    acknowledgements,
    state: () => state,
    deny: () => {
      deny = true;
    },
    failSave: (v: boolean) => {
      failSave = v;
    },
    failExecution: (error: Error = new Error("uncertain side effect")) => {
      failure = error;
    },
  };
}

test.each(["create", "stop", "delete"] as const)(
  "%s durably records intent before execution and repeats only its saved acknowledgement",
  async (operation) => {
    const f = fixture(operation);
    f.failSave(true);
    await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("disk unavailable");
    expect(f.executed).toEqual([]);
    f.failSave(false);
    await tick(f.store, f.api, f.executor);
    // A new iteration reloads only durable state, as a restarted process does.
    await tick(f.store, f.api, f.executor);
    expect(f.executed).toEqual([operation]);
    expect(f.acknowledgements).toEqual(["completed", "completed"]);
  },
);

test("recovers a persisted pending operation after interruption without issuing a new identity", async () => {
  const f = fixture();
  let interrupted = false;
  f.executor.isAbsent = async () => true;
  f.executor.isStopped = async () => false;
  f.api.cleaned = async () => {
    throw new Error("unfinished admission must not be reported as loss");
  };
  const store: Store = {
    load: f.store.load,
    async save(state) {
      await f.store.save(state);
      if (!interrupted) {
        interrupted = true;
        throw new Error("interrupted after persistence");
      }
    },
  };
  await expect(tick(store, f.api, f.executor)).rejects.toThrow("interrupted");
  expect(f.executed).toEqual([]);
  await tick(f.store, f.api, f.executor);
  expect(f.executed).toEqual(["create"]);
  expect(f.acknowledgements).toEqual(["completed"]);
  expect((await f.store.load()).retention).toEqual([]);
});

test("a persisted pending create cannot allocate while polling is offline or denied", async () => {
  const f = fixture();
  const store: Store = {
    load: f.store.load,
    async save(state) {
      await f.store.save(state);
      throw new Error("interrupted after persistence");
    },
  };
  await expect(tick(store, f.api, f.executor)).rejects.toThrow("interrupted");
  f.deny();
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("denied");
  expect(f.executed).toEqual([]);
  expect(f.swept).toEqual([f.job.request.generation]);
  expect(f.state().receipts[0]?.outcome).toBeUndefined();
});

test("rejects changed request identity, generation inputs, and fresh create identities for a recorded generation", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const original = structuredClone(f.job);
  f.job.request.ttlSeconds++;
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed host job");
  f.job.requestId = crypto.randomUUID();
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed machine generation");
  f.job.request = original.request;
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed machine generation");
  expect(f.executed).toHaveLength(1);
});

test("a failed image fetch is reported with its reason, and an older server still gets the plain outcome", async () => {
  const f = fixture();
  f.failExecution(new DockerMachineError("image_unavailable"));
  await tick(f.store, f.api, f.executor);
  expect(f.state().receipts[0]).toMatchObject({ outcome: "failed", reason: "image_unavailable" });
  const generic = fixture();
  generic.failExecution(new DockerMachineError("docker_failed"));
  await tick(generic.store, generic.api, generic.executor);
  expect(generic.state().receipts[0]?.reason).toBeUndefined();

  // A transient failure is not an older server: the reason is kept for the next tick, never dropped.
  const sent: Record<string, unknown>[] = [];
  const transient = httpApi((async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 503 });
  }) as typeof fetch);
  await expect(transient.result(f.state(), f.state().receipts[0] ?? fail())).rejects.toThrow("Host request denied");
  expect(sent).toEqual([expect.objectContaining({ reason: "image_unavailable" })]);
  for (const server of ["current", "older"] as const) {
    const bodies: Record<string, unknown>[] = [];
    const api = httpApi((async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      // An older server refuses any field it does not know.
      return new Response(null, { status: server === "older" && "reason" in body ? 400 : 204 });
    }) as typeof fetch);
    await api.result(f.state(), f.state().receipts[0] ?? fail());
    const plain = { installationId: f.state().installationId, requestId: f.job.requestId, outcome: "failed" };
    expect(bodies).toEqual(
      server === "current"
        ? [{ ...plain, reason: "image_unavailable" }]
        : [{ ...plain, reason: "image_unavailable" }, plain],
    );
  }
});

test("uncertain execution fails durably, never replays, and TTL sweep still runs on denied polling", async () => {
  const f = fixture();
  f.failExecution();
  await tick(f.store, f.api, f.executor);
  await tick(f.store, f.api, f.executor);
  expect(f.executed).toEqual(["create"]);
  expect(f.acknowledgements).toEqual(["failed", "failed"]);
  f.deny();
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("denied");
  expect(f.swept).toEqual([f.job.request.generation, f.job.request.generation]);
});

test("offline TTL stop confirmation survives restart and lost ACK without replaying compute or exposing credentials", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  f.deny();
  const state = f.state();
  const r = f.job.request;
  const name = `armada-${state.installationId}-${state.hostId}-${r.sandboxId}-${r.generation}`;
  const labels = Object.fromEntries(
    Object.entries({
      installation: state.installationId,
      host: state.hostId,
      sandbox: r.sandboxId,
      generation: r.generation,
      image: r.image,
      "ttl-seconds": String(r.ttlSeconds),
      "created-at": "1000",
      "expires-at": "61000",
    }).map(([key, value]) => [`dev.armada.machine.${key}`, value]),
  );
  let running = true;
  const calls: string[][] = [];
  const executor = createDockerMachineExecutor({
    installationId: state.installationId,
    hostId: state.hostId,
    now: () => 62000,
    cli: {
      async run(argv) {
        calls.push([...argv]);
        const container = argv[0] === "container";
        if (argv[1] === "ls") return { exitCode: 0, stdout: JSON.stringify(container ? name : `${name}-home`) };
        if (argv[1] === "inspect")
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              container
                ? {
                    Name: `/${name}`,
                    Config: { Image: r.image, User: "1000:1000", Labels: labels },
                    HostConfig: { Privileged: false },
                    Mounts: [{ Type: "volume", Name: `${name}-home`, Destination: "/home/user", RW: true }],
                    State: { Running: running, Status: running ? "running" : "exited" },
                  }
                : { Name: `${name}-home`, Driver: "local", Options: {}, Labels: labels },
            ]),
          };
        if (argv[1] !== "stop") throw new Error("Unexpected Docker operation");
        expect(argv.at(-1)).toBe(name);
        running = false;
        return { exitCode: 0, stdout: "" };
      },
    },
  });
  let offline = true,
    loseAck = true,
    reports = 0,
    attempts = 0;
  const api: Api = {
    ...f.api,
    async poll() {
      if (offline) throw new Error("denied");
      return { job: null };
    },
    async result(_state, receipt, expired) {
      attempts++;
      expect(expired).toBe(true);
      expect((await f.store.load()).receipts[0]?.expired).toBe(true);
      expect(receipt.requestId).toBe(f.job.requestId);
      if (offline) throw new Error("offline");
      reports++;
      if (loseAck) {
        loseAck = false;
        throw new Error("lost ACK");
      }
    },
  };
  f.failSave(true);
  await expect(tick(f.store, api, executor)).rejects.toThrow("denied");
  expect(running).toBe(false);
  expect(attempts).toBe(0);
  expect(f.state().receipts[0]?.expired).toBeUndefined();
  f.failSave(false);
  await expect(tick(f.store, api, executor)).rejects.toThrow("denied");
  expect(running).toBe(false);
  expect(f.state().receipts[0]).toMatchObject({ expired: true, outcome: "completed" });
  expect(f.state().receipts[0]?.expiryReported).toBeUndefined();
  expect(JSON.stringify(calls)).not.toContain(state.hostToken);
  // Reload the durable receipt; a later unavailable daemon cannot erase the proof.
  const restarted = {
    ...executor,
    async stopIfExpired() {
      throw new Error("Docker offline");
    },
  };
  offline = false;
  await tick(f.store, api, restarted);
  expect(f.state().receipts[0]?.expiryReported).toBeUndefined();
  await tick(f.store, api, restarted);
  expect(f.state().receipts[0]?.expiryReported).toBe(true);
  await tick(f.store, api, restarted);
  expect(reports).toBe(2);
  expect(attempts).toBe(3);
  expect(f.executed).toEqual(["create"]);
});

test("bounded TTL sweeps retire confirmed generations while reporting fairly across restarted ticks", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const first = f.job.requestId;
  f.job.requestId = crypto.randomUUID();
  f.job.request = { ...f.job.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() };
  await tick(f.store, f.api, f.executor);
  const second = f.job.requestId;
  const swept: string[] = [],
    reports: string[] = [],
    sweepCounts: number[] = [];
  const executor: Executor = {
    ...f.executor,
    async stopIfExpired(request) {
      swept.push(request.sandboxId);
      return true;
    },
  };
  const api: Api = {
    ...f.api,
    async poll() {
      return { job: null };
    },
    async result(_state, receipt, expired) {
      if (!expired) throw new Error("Unexpected job execution");
      reports.push(receipt.requestId);
      sweepCounts.push(swept.length);
      throw new Error("Timed-out HTTP transport");
    },
  };
  await tick(f.store, api, executor);
  expect(reports).toEqual([first]);
  // Each tick reloads only durable state; no in-memory cursor is supplied by the fixture.
  await tick(f.store, api, executor);
  expect(reports).toEqual([first, second]);
  await tick(f.store, api, executor);
  expect(reports).toEqual([first, second, first]);
  expect(sweepCounts).toEqual([1, 2, 2]);
  expect(f.executed).toEqual(["create", "create"]);
});

test("HTTP registration is single-use and host credentials remain in authorization headers", async () => {
  const f = fixture();
  const registrationToken = randomBytes(32).toString("hex");
  const hostToken = randomBytes(32).toString("hex");
  const hostId = crypto.randomUUID();
  const calls: { url: string; init: RequestInit }[] = [];
  const api = httpApi((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("register")) return Response.json({ hostId, hostToken });
    if (String(url).endsWith("poll")) return Response.json({ job: null });
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  await register(f.store, api, "https://armada.example/", registrationToken);
  const state = await f.store.load();
  expect(JSON.parse(String(calls[0]?.init.body)).installationId).toBe(state.installationId);
  expect(state.installationId).toMatch(/^[0-9a-f-]{36}$/);
  await api.poll(state);
  await api.result(state, {
    requestId: f.job.requestId,
    operation: "create",
    request: f.job.request,
    outcome: "completed",
  });
  await api.result(state, { requestId: f.job.requestId, operation: "create", request: f.job.request }, true);
  expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
    installationId: state.installationId,
    requestId: f.job.requestId,
    expired: true,
  });
  expect(calls.map((c) => c.init.headers)).toEqual([
    { authorization: `Bearer ${registrationToken}`, "content-type": "application/json" },
    { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
    { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
    { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
  ]);
  expect(calls.every((c) => c.init.redirect === "error" && !`${c.url}${c.init.body}`.includes(hostToken))).toBe(true);
  expect(JSON.stringify(state)).not.toContain(registrationToken);
  let attempts = 0;
  await expect(
    register(
      f.store,
      {
        ...api,
        async register() {
          attempts++;
          throw new Error("offline");
        },
      },
      state.server,
      registrationToken,
    ),
  ).rejects.toThrow("offline");
  expect(attempts).toBe(1);
});

test("private native state survives reopening, excludes concurrent owners and rejects unsafe existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-docker-host-"));
  try {
    const store = await fileStore(directory);
    await store.save(fixture().state());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await (await fileStore(directory)).load()).toEqual(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    );
    const priorBoot = join(directory, "daemon-00000000-0000-0000-0000-000000000000.lock");
    if (process.platform === "linux") await writeFile(priorBoot, "", { mode: 0o600 });
    const release = await store.lock();
    await expect(store.lock()).rejects.toThrow();
    await release();
    if (process.platform === "linux") {
      expect(await readFile(priorBoot, "utf8")).toBe("");
      await writeFile(join(directory, "daemon.lock"), "", { mode: 0o600 });
      await expect(store.lock()).rejects.toThrow("Legacy daemon lock");
    }
    await chmod(join(directory, "state.json"), 0o644);
    await expect(store.load()).rejects.toThrow("Unsafe host state");
    await expect(store.save(fixture().state())).rejects.toThrow("Unsafe host state");
    await rm(join(directory, "state.json"));
    await symlink(join(directory, "other"), join(directory, "state.json"));
    await expect(store.load()).rejects.toThrow();
    await chmod(directory, 0o755);
    await expect(fileStore(directory)).rejects.toThrow("Unsafe state directory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// One owner boundary for write/read compatibility: a large save may be refused,
// but must never replace readable state with a file its own reader rejects.
test("native state writes remain readable or preserve the previous durable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-docker-state-size-"));
  try {
    const f = fixture();
    const store = await fileStore(directory);
    const previous = f.state();
    await store.save(previous);
    const next = {
      ...previous,
      receipts: Array.from({ length: 100_000 }, () => ({
        requestId: f.job.requestId,
        operation: "create" as const,
        request: f.job.request,
        outcome: "completed" as const,
      })),
    };
    let accepted = false;
    try {
      await store.save(next);
      accepted = true;
    } catch {
      /* a bounded persistence layer may refuse admission */
    }
    const restored = await store.load();
    expect(JSON.stringify(restored) === JSON.stringify(accepted ? next : previous)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function bootstrapDescriptor(): BootstrapDescriptor {
  return {
    serverUrl: "https://armada.example",
    artifact: { sha256: "b".repeat(64), bytes: 123 },
    enrolmentToken: `armada_enrol_${"c".repeat(64)}`,
  };
}

test("bootstrap executes once with a private descriptor; identity changes and off-origin delivery cannot execute", async () => {
  const descriptor = bootstrapDescriptor();
  const f = fixture("create", descriptor);
  let delivered: BootstrapDescriptor | undefined;
  const executor = {
    ...f.executor,
    async startRuntime(request: Job["request"], bootstrap: BootstrapDescriptor) {
      expect(request).toEqual(f.job.request);
      expect(JSON.stringify(f.state())).not.toContain(descriptor.enrolmentToken);
      await f.executor.startRuntime?.(request, bootstrap);
      delivered = bootstrap;
    },
  };
  await tick(f.store, f.api, executor);
  await tick(f.store, f.api, executor);
  expect(delivered).toEqual(descriptor);
  expect(f.executed).toEqual(["bootstrap"]);
  expect(f.acknowledgements).toEqual(["completed", "completed"]);
  expect(f.state().receipts[0]).toEqual({
    requestId: f.job.requestId,
    operation: "bootstrap",
    request: f.job.request,
    inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    outcome: "completed",
  });
  if (f.job.operation !== "bootstrap") throw new Error("Expected bootstrap");
  f.job.bootstrap.enrolmentToken = `armada_enrol_${"d".repeat(64)}`;
  await expect(tick(f.store, f.api, executor)).rejects.toThrow("Changed host job");
  f.job.requestId = crypto.randomUUID();
  await expect(tick(f.store, f.api, executor)).rejects.toThrow("Changed machine generation");
  const wrong = fixture("create", { ...descriptor, serverUrl: "https://other.example" });
  await expect(tick(wrong.store, wrong.api, wrong.executor)).rejects.toThrow("Wrong bootstrap origin");
  expect(wrong.state().receipts).toEqual([]);
  expect(wrong.executed).toEqual([]);
  const denied = fixture("create", descriptor);
  denied.deny();
  await expect(tick(denied.store, denied.api, denied.executor)).rejects.toThrow("denied");
  expect(denied.executed).toEqual([]);
});

test("pending bootstrap is terminally unknown on recovery, before invocation or after an outcome-save failure", async () => {
  for (const interruptedAfter of ["intent", "execution"]) {
    const f = fixture("create", bootstrapDescriptor());
    let saves = 0;
    const store: Store = {
      load: f.store.load,
      async save(state) {
        saves++;
        if (saves === 2 && interruptedAfter === "execution") throw new Error("disk unavailable");
        await f.store.save(state);
        if (saves === 1 && interruptedAfter === "intent") throw new Error("interrupted");
      },
    };
    await expect(tick(store, f.api, f.executor)).rejects.toThrow();
    expect(f.state().receipts[0]?.outcome).toBeUndefined();
    await tick(f.store, f.api, f.executor);
    await tick(f.store, f.api, f.executor);
    expect(f.executed).toEqual(interruptedAfter === "execution" ? ["bootstrap"] : []);
    expect(f.acknowledgements).toEqual(["failed", "failed"]);
    f.job.requestId = crypto.randomUUID();
    await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed machine generation");
  }
});

test("saved generation identity fences absolute expiry across repeated and fresh operation IDs", async () => {
  const f = fixture();
  f.job.request.expiresAt = 1_700_000_000_000;
  await tick(f.store, f.api, f.executor);
  f.job.request.expiresAt++;
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed host job");
  f.job.requestId = crypto.randomUUID();
  f.job.operation = "stop";
  await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("Changed machine generation");
  f.job.request.expiresAt--;
  await tick(f.store, f.api, f.executor);
  expect(f.executed).toEqual(["create", "stop"]);
});

test("resume starts the retained container before fresh runtime bootstrap and never replays a completed resume", async () => {
  const f = fixture("create", bootstrapDescriptor());
  if (f.job.operation !== "bootstrap") throw Error("missing bootstrap fixture");
  f.job.operation = "resume";
  const calls: string[] = [];
  const executor: Executor = {
    ...f.executor,
    async resume() {
      calls.push("start");
    },
    async startRuntime() {
      calls.push("bootstrap");
    },
  };
  await tick(f.store, f.api, executor);
  await tick(f.store, f.api, executor);
  expect(calls).toEqual(["start", "bootstrap"]);
  expect(f.acknowledgements).toEqual(["completed", "completed"]);
});

test("unregister distinguishes a pending drain from confirmed revocation and rejects unknown responses", async () => {
  const state = fixture().state();
  for (const result of [false, true]) {
    const api = httpApi((async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).toBe(`${state.server}/api/docker-host/unregister`);
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${state.hostToken}`);
      expect(JSON.parse(String(options?.body))).toEqual({ installationId: state.installationId });
      return Response.json({ revoked: result });
    }) as typeof fetch);
    expect(await api.unregister(state)).toBe(result);
  }
  for (const response of [{}, { revoked: "true" }, { revoked: true, unknown: true }, null]) {
    await expect(
      httpApi((async (_url: string | URL | Request, _options?: RequestInit) =>
        Response.json(response)) as typeof fetch).unregister(state),
    ).rejects.toThrow("Invalid host revocation response");
  }
});

// The daemon's loop passes `dispatch`, but an older server never holds a poll, so
// the build still runs inline and must keep the other work moving (#2561).
for (const [caller, options] of [
  ["a serial caller", {}],
  [
    "the job loop against a server that cannot hold a poll",
    {
      waitSeconds: 20,
      running: new Set<string>(),
      sandboxes: new Set<string>(),
      dispatch: () => {
        throw Error("A poll that was not held must not dispatch.");
      },
    },
  ],
] as const)
  test(`snapshot builds keep ordinary stop/TTL work responsive and merge durable receipts without retaining credentials (${caller})`, async () => {
    const hostId = crypto.randomUUID(),
      installationId = crypto.randomUUID(),
      snapshotId = crypto.randomUUID();
    const normal = {
      sandboxId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      image: `base@sha256:${"a".repeat(64)}`,
      ttlSeconds: 60,
      expiresAt: 10000,
    };
    const priorId = crypto.randomUUID(),
      stopId = crypto.randomUUID();
    const token = "offline-build-token";
    const build: Job = {
      requestId: snapshotId,
      operation: "buildSnapshot",
      request: { ...normal, sandboxId: snapshotId, generation: crypto.randomUUID() },
      build: {
        armadaVersion: "2.28.0",
        id: snapshotId,
        ownerId: crypto.randomUUID(),
        visibility: "private",
        token,
        config: {
          repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }],
          init: [],
        },
      },
    };
    const stop: Job = { requestId: stopId, operation: "stop", request: normal };
    let state: State = {
      server: "https://armada.example",
      hostId,
      installationId,
      hostToken: "a".repeat(64),
      receipts: [{ requestId: priorId, request: normal, operation: "create", outcome: "completed" }],
    };
    const store: Store = {
      load: async () => structuredClone(state),
      save: async (next) => {
        state = structuredClone(next);
      },
    };
    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<string>();
    let building = false,
      physicalExpiryDuringBuild = false,
      stops = 0,
      builds = 0;
    const api: Api = {
      register: async () => {
        throw Error("unused");
      },
      poll: async (_state, options) => ({ job: options?.skipSnapshots ? stop : build }),
      result: async () => {},
    };
    const executor: Executor = {
      create: async () => {},
      delete: async () => {},
      stop: async () => {
        stops++;
      },
      stopIfExpired: async () => {
        physicalExpiryDuringBuild ||= building;
        return building;
      },
      buildSnapshot: async () => {
        builds++;
        building = true;
        started.resolve();
        return finish.promise;
      },
    };
    const interval = globalThis.setInterval,
      clear = globalThis.clearInterval;
    let pump: (() => void | Promise<void>) | undefined, running: Promise<unknown> | undefined;
    globalThis.setInterval = ((callback: () => void | Promise<void>) => {
      pump = callback;
      return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    try {
      running = tick(store, api, executor, false, Date.now, options);
      await started.promise;
      if (!pump) throw Error("missing build work pump");
      await pump();
      expect(physicalExpiryDuringBuild).toBe(true);
      expect(stops).toBe(1);
      finish.resolve(`sha256:${"b".repeat(64)}`);
      await running;
      expect(state.receipts.find((r) => r.requestId === snapshotId)).toMatchObject({
        operation: "buildSnapshot",
        outcome: "completed",
        imageId: `sha256:${"b".repeat(64)}`,
      });
      expect(state.receipts.find((r) => r.requestId === stopId)?.outcome).toBe("completed");
      expect(state.receipts.find((r) => r.requestId === priorId)?.expired).toBe(true);
      expect(JSON.stringify(state)).not.toContain(token);
      await tick(store, api, executor);
      expect(builds).toBe(1);
    } finally {
      finish.resolve(`sha256:${"b".repeat(64)}`);
      await running?.catch(() => {});
      globalThis.setInterval = interval;
      globalThis.clearInterval = clear;
    }
  });

// The no-Node fallback must not label arbitrary HTTP output as a canceled ticket/name.
test("HTTP reuse authenticates only with the fresh ticket and validates public identity before confirmation", async () => {
  const state = fixture().state();
  const token = "c".repeat(64);
  const before = JSON.stringify(state);
  for (const name of ["owner-machine", null]) {
    const api = httpApi((async (url, options) => {
      expect(String(url)).toBe(`${state.server}/api/docker-host/reuse-registration`);
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(JSON.parse(String(options?.body))).toEqual({ hostId: state.hostId });
      expect(String(options?.body)).not.toContain(state.hostToken);
      return Response.json({ hostId: state.hostId, name });
    }) as typeof fetch);
    expect(await api.reuseRegistration(state, token)).toEqual({ hostId: state.hostId, name });
  }
  for (const value of [
    null,
    {},
    { hostId: state.hostId },
    { hostId: crypto.randomUUID(), name: "wrong" },
    { hostId: state.hostId, name: "bad\nname" },
    { hostId: state.hostId, name: "x", secret: "unexpected" },
  ])
    await expect(
      httpApi((async (_url: string | URL | Request, _options?: RequestInit) =>
        Response.json(value)) as typeof fetch).reuseRegistration(state, token),
    ).rejects.toThrow("Invalid existing host identity");
  await expect(
    httpApi(
      (async (_url: string | URL | Request, _options?: RequestInit) =>
        new Response(null, { status: 302 })) as typeof fetch,
    ).reuseRegistration(state, token),
  ).rejects.toThrow("Host request denied");
  expect(JSON.stringify(state)).toBe(before);
});

test("snapshot failures durably report a bounded reason and log no exception output", async () => {
  const f = fixture();
  const id = f.job.request.sandboxId;
  const job: Job = {
    ...f.job,
    operation: "buildSnapshot",
    request: { ...f.job.request, ttlSeconds: 3600, expiresAt: Date.now() + 3600000 },
    build: {
      id,
      armadaVersion: "2.29.0",
      ownerId: crypto.randomUUID(),
      visibility: "private",
      token: "offline-snapshot-access",
      config: { repos: [{ url: "https://github.com/example/project.git", branch: "main", dir: "project" }], init: [] },
    },
  };
  f.api.poll = async () => ({ job });
  f.executor.buildSnapshot = async () => {
    throw Error("private-command-output");
  };
  const original = console.error,
    messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.join(" "));
  };
  try {
    await tick(f.store, f.api, f.executor);
    expect(f.state().receipts[0]).toMatchObject({ outcome: "failed", reason: "snapshot_build_failed" });
    expect(messages.join(" ")).toContain(id);
    expect(messages.join(" ")).toContain("Snapshot image build failed");
    expect(messages.join(" ")).not.toContain("private-command-output");
    expect(JSON.stringify(f.state())).not.toContain("private-command-output");
  } finally {
    console.error = original;
  }
});

test("poll policy is applied before machine work and older-server absence resets it", async () => {
  const f = fixture();
  const limits = { cpus: 0.5, memoryBytes: 512 * 1024 ** 2, pids: 4096 };
  const applied: unknown[] = [];
  f.executor.configureLimits = (value) => {
    applied.push(value);
  };
  const original = f.executor.create;
  f.executor.create = async (request) => {
    expect(applied).toEqual([limits]);
    return original(request);
  };
  f.api.poll = async () => ({ job: f.job, limits });
  await tick(f.store, f.api, f.executor);
  f.api.poll = async () => ({ job: null });
  await tick(f.store, f.api, f.executor);
  expect(applied).toEqual([limits, undefined]);
});

test("compaction preserves cleanup capacity, TTL facts and stored replay fences", async () => {
  const f = fixture("delete");
  const store: Store = {
    load: () => f.store.load(),
    async save(state) {
      compactReceipts(state);
      await f.store.save(state);
    },
  };
  const initial = await f.store.load();
  const old = {
    requestId: crypto.randomUUID(),
    operation: "delete" as const,
    outcome: "completed" as const,
    request: {
      ...f.job.request,
      sandboxId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      image: `sha256:${"a".repeat(64)}`,
    },
  };
  // Exceed the default cleanup capacity, not an incidental near-limit file size.
  initial.receipts = Array.from({ length: 17409 }, (_, index) => {
    const suffix = index.toString(16).padStart(12, "0");
    return {
      ...old,
      requestId: `11111111-1111-4111-8111-${suffix}`,
      request: {
        ...old.request,
        sandboxId: `22222222-2222-4222-8222-${suffix}`,
        generation: `33333333-3333-4333-8333-${suffix}`,
      },
    };
  });
  const replay = initial.receipts[0]!;
  const pending = { request: old.request, operation: "stop" as const, requestId: crypto.randomUUID() };
  const active = { ...old, requestId: crypto.randomUUID(), operation: "create" as const };
  initial.receipts.push(pending, active);
  initial.retention = [{ request: active.request, requestId: active.requestId, deadline: 86400000 }];
  expect(Buffer.byteLength(JSON.stringify(initial))).toBeGreaterThan(1024 * 1024);
  await store.save(initial);
  let effects = 0;
  const executor: Executor = {
    async create() {
      effects++;
    },
    async stop() {
      effects++;
    },
    async delete() {
      effects++;
    },
    async stopIfExpired() {
      return true;
    },
  };
  let job: Job = f.job;
  const expiredReports: string[] = [];
  const outcomes: string[] = [];
  const api: Api = {
    ...f.api,
    async poll() {
      return { job };
    },
    async result(_state, receipt, expired) {
      if (expired) expiredReports.push(receipt.requestId);
      else outcomes.push(receipt.outcome ?? "pending");
    },
  };
  await tick(store, api, executor);
  const saved = await store.load();
  expect(effects).toBe(1);
  expect(saved.receipts.some((r) => r.requestId === pending.requestId && !r.outcome)).toBe(true);
  expect(saved.retired?.some((r) => r[0] === active.requestId)).toBe(true);
  expect(expiredReports).toContain(active.requestId);
  job = { requestId: replay.requestId, operation: replay.operation, request: replay.request } as Job;
  await tick(store, api, executor);
  expect(outcomes.at(-1)).toBe("completed");
  expect(effects).toBe(1);
  job = { request: active.request, requestId: crypto.randomUUID(), operation: "create" };
  await expect(tick(store, api, executor)).rejects.toThrow("Retired machine generation");
  expect(effects).toBe(1);
});

test("native poll retains sampled availability when an older server rejects retention telemetry", async () => {
  let calls = 0;
  const f = fixture();
  const resources = { cpus: 8, memoryBytes: 32 * 1024 ** 3, availableCpus: 3, availableMemoryBytes: 12 * 1024 ** 3 };
  const api = httpApi(
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls++;
        expect(body.resources).toEqual(resources);
        if ("retentionSeconds" in body) return new Response(null, { status: 400 });
        expect(JSON.stringify(body)).not.toContain(f.state().hostToken);
        return Response.json({ job: null });
      },
      { preconnect: fetch.preconnect },
    ),
    async () => resources,
  );
  expect(await api.poll(await f.store.load())).toEqual({ job: null });
  expect(calls).toBe(3);
});

test("older policy-capable servers retain the quota handshake when availability fields are refused", async () => {
  const f = fixture();
  let calls = 0;
  const api = httpApi(
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(body.resourcePolicyVersion).toBe(1);
        if ("availableCpus" in body.resources) return new Response(null, { status: 400 });
        return Response.json({ job: null, limits: { cpus: 1, memoryBytes: 1024 ** 3, pids: 4096 } });
      },
      { preconnect: fetch.preconnect },
    ),
    async () => ({ cpus: 8, memoryBytes: 32 * 1024 ** 3, availableCpus: 2, availableMemoryBytes: 10 * 1024 ** 3 }),
  );
  expect(await api.poll(await f.store.load())).toMatchObject({ limits: { cpus: 1 } });
  expect(calls).toBe(4);
});

test("TTL index deduplicates active receipts, retires terminal history and rotates uncertain failures before mailbox polling", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const legacy = await f.store.load();
  delete legacy.activeTtl;
  const original = legacy.receipts[0] ?? fail();
  const terminal = {
    ...original,
    requestId: crypto.randomUUID(),
    request: { ...original.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() },
    expired: true as const,
    expiryReported: true as const,
  };
  const later = {
    ...original,
    requestId: crypto.randomUUID(),
    request: { ...original.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() },
  };
  legacy.receipts.push(
    { ...original, requestId: crypto.randomUUID(), operation: "resume", inputHash: "resume_input" },
    terminal,
    {
      ...original,
      request: terminal.request,
      requestId: crypto.randomUUID(),
      operation: "bootstrap",
      inputHash: "bootstrap_input",
    },
    later,
  );
  await f.store.save(legacy);
  const checked: string[] = [];
  let polls = 0;
  const executor: Executor = {
    ...f.executor,
    async stopIfExpired(request) {
      checked.push(request.generation);
      if (request.generation === original.request.generation) throw new Error("uncertain Docker outcome");
      return true;
    },
  };
  const api: Api = {
    ...f.api,
    async poll() {
      polls++;
      throw new Error("offline");
    },
    async result() {},
  };
  for (let i = 0; i < 4; i++) await expect(tick(f.store, api, executor)).rejects.toThrow("offline");
  expect(checked).toEqual([
    original.request.generation,
    later.request.generation,
    original.request.generation,
    original.request.generation,
  ]);
  expect(polls).toBe(4);
  expect((await f.store.load()).receipts).toHaveLength(5);
});

// Build legacy compacted state through the production compactor, not invented fences.
test.each(["stop", "delete", "expired", "resumed"] as const)(
  "legacy compacted %s history preserves only uncertain live TTL obligations",
  async (kind) => {
    const f = fixture();
    await tick(f.store, f.api, f.executor);
    const state = await f.store.load();
    delete state.activeTtl;
    const original = state.receipts[0] ?? fail();
    if (kind === "expired") {
      original.expired = true;
      original.expiryReported = true;
      state.receipts.push({
        ...original,
        operation: "bootstrap",
        inputHash: "bootstrap_input",
        requestId: crypto.randomUUID(),
      });
      const bootstrap = state.receipts[1] ?? fail();
      delete bootstrap.expired;
      delete bootstrap.expiryReported;
    } else {
      state.receipts.push({
        request: original.request,
        requestId: crypto.randomUUID(),
        operation: kind === "delete" ? "delete" : "stop",
        outcome: "completed",
      });
      if (kind === "resumed")
        state.receipts.push({
          ...original,
          operation: "resume",
          inputHash: "resume_input",
          requestId: crypto.randomUUID(),
        });
    }
    // Reach the real compaction threshold with closed unrelated receipts.
    state.receipts.push(
      ...Array.from({ length: 4500 }, () => ({
        request: { ...original.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() },
        requestId: crypto.randomUUID(),
        operation: "delete" as const,
        outcome: "completed" as const,
      })),
    );
    compactReceipts(state);
    expect(state.retired?.length).toBeGreaterThan(0);
    await f.store.save(state);
    f.swept.length = 0;
    f.deny();
    await expect(tick(f.store, f.api, f.executor)).rejects.toThrow("denied");
    expect(f.swept).toEqual(kind === "resumed" ? [original.request.generation] : []);
  },
);

test("durable retention cleans only stopped allocations after the deadline while offline and retries reconciliation", async () => {
  const f = fixture();
  let now = 1000;
  let stopped = false;
  let deletes = 0;
  let reports = 0;
  const executor: Executor = {
    create: async () => {},
    stop: async () => {},
    delete: async () => {},
    stopIfExpired: async () => false,
    isStopped: async () => stopped,
    isRunning: async () => !stopped,
    deleteStopped: async () => {
      deletes++;
    },
  };
  const api: Api = {
    register: async () => {
      throw Error("unused");
    },
    poll: async () => ({ job: f.job }),
    result: async () => {},
    cleaned: async () => {
      reports++;
      throw Error("offline");
    },
  };
  await tick(f.store, api, executor, false, () => now);
  stopped = true;
  api.poll = async () => {
    throw Error("offline");
  };
  await tick(f.store, api, executor, false, () => now).catch(() => {});
  expect((await f.store.load()).retention?.[0]?.deadline).toBe(86401000);
  now = 86400999;
  await tick(f.store, api, executor, false, () => now).catch(() => {});
  expect(deletes).toBe(0);
  now++;
  await tick(f.store, api, executor, false, () => now).catch(() => {});
  expect(deletes).toBe(1);
  expect(reports).toBe(1);
  api.cleaned = async () => {
    reports++;
  };
  stopped = false;
  await tick(f.store, api, executor, false, () => now).catch(() => {});
  expect(deletes).toBe(1);
  expect(reports).toBe(2);
  expect((await f.store.load()).retention).toEqual([]);
});

test("default retention reclaims expired stopped workspaces with ample free disk", async () => {
  const f = fixture("stop");
  f.job.request.expiresAt = 1000;
  await tick(f.store, f.api, f.executor, false, () => 0);
  f.api.poll = async () => ({ job: null });
  f.executor.isStopped = async () => true;
  f.executor.diskFreeBytes = async () => 20_000_000_000;
  let deletes = 0;
  f.executor.deleteStopped = async () => {
    deletes++;
  };
  await tick(f.store, f.api, f.executor, false, () => 2000);
  expect(deletes).toBe(1);
});

test("physical resume cancels retention even when its RPC outcome was uncertain", async () => {
  const f = fixture();
  let stopped = true;
  let now = 10;
  let deletes = 0;
  const executor: Executor = {
    create: async () => {},
    stop: async () => {},
    delete: async () => {},
    stopIfExpired: async () => false,
    isStopped: async () => stopped,
    isRunning: async () => !stopped,
    deleteStopped: async () => {
      deletes++;
    },
  };
  const api: Api = {
    register: async () => {
      throw Error("unused");
    },
    poll: async () => ({ job: f.job }),
    result: async () => {},
  };
  await tick(f.store, api, executor, false, () => now);
  await tick(f.store, api, executor, false, () => now);
  expect((await f.store.load()).retention).toHaveLength(1);
  stopped = false;
  now += 86400000;
  await tick(f.store, api, executor, false, () => now);
  expect(deletes).toBe(0);
  expect((await f.store.load()).retention).toEqual([]);
});

test("retention rotates failed deletions and runs local TTL before bounded offline reports", async () => {
  const f = fixture();
  const order: string[] = [];
  const executor: Executor = {
    create: async () => {},
    stop: async () => {},
    delete: async () => {},
    stopIfExpired: async (request) => {
      order.push(`ttl:${request.sandboxId}`);
      return false;
    },
    deleteStopped: async (request) => {
      order.push(`delete:${request.sandboxId}`);
      if (request.sandboxId === firstId) throw Error("Docker refused");
    },
  };
  const api: Api = {
    register: async () => {
      throw Error("unused");
    },
    poll: async () => ({ job: f.job }),
    result: async () => {},
    cleaned: async () => {
      order.push("report");
      throw Error("offline");
    },
  };
  const firstId = f.job.request.sandboxId;
  await tick(f.store, api, executor, false, () => 100);
  f.job.requestId = crypto.randomUUID();
  f.job.request = { ...f.job.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() };
  const secondId = f.job.request.sandboxId;
  await tick(f.store, api, executor, false, () => 100);
  const state = await f.store.load();
  state.retention = state.receipts.map((receipt) => ({
    request: receipt.request,
    requestId: receipt.requestId,
    deadline: 100,
  }));
  await f.store.save(state);
  api.poll = async () => {
    throw Error("offline");
  };
  order.length = 0;
  await tick(f.store, api, executor, false, () => 100).catch(() => {});
  expect(order).toEqual([`delete:${firstId}`, `ttl:${firstId}`]);
  order.length = 0;
  await tick(f.store, api, executor, false, () => 100).catch(() => {});
  expect(order).toEqual([`delete:${secondId}`, `ttl:${secondId}`, "report"]);
  expect((await f.store.load()).retention?.[1]?.deleted).toBe(true);
});

test("server retention override persists and shifts pending deadlines without resetting their stopped age", async () => {
  const f = fixture();
  f.job.request.expiresAt = 15000000;
  await tick(f.store, f.api, f.executor, false, () => 0);
  const state = await f.store.load();
  state.retentionSeconds = 86400;
  state.retention = [{ request: f.job.request, requestId: f.job.requestId, deadline: 100000000 }];
  await f.store.save(state);
  // A completed-job replay must not bypass durable policy storage.
  f.api.poll = async () => ({ job: f.job, retentionSeconds: 3600 });
  await tick(f.store, f.api, f.executor);
  expect((await f.store.load()).retentionSeconds).toBe(3600);
  expect((await f.store.load()).retentionPolicyFromServer).toBe(true);
  expect((await f.store.load()).retention?.[0]?.deadline).toBe(17200000);
});

test("a pre-disk server keeps retention and availability when refusing only disk telemetry", async () => {
  const f = fixture();
  const resources = { cpus: 8, memoryBytes: 32 * 1024 ** 3, availableCpus: 3, availableMemoryBytes: 12 * 1024 ** 3 };
  let calls = 0;
  const api = httpApi(
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(body.resources).toEqual(resources);
        expect(body.retentionSeconds).toBe(86400);
        if ("diskFreeBytes" in body) {
          expect(body.diskFreeBytes).toBe(123);
          return new Response(null, { status: 400 });
        }
        return Response.json({ job: null, retentionSeconds: 3600 });
      },
      { preconnect: fetch.preconnect },
    ),
    async () => resources,
    async () => 123,
  );
  expect(await api.poll(await f.store.load())).toEqual({ job: null, retentionSeconds: 3600 });
  expect(calls).toBe(3);
});

test.each(["resumeClaimProtocol", "stoppedSandboxBytes"])(
  "an older server keeps disk telemetry when refusing %s",
  async (unsupported) => {
    const f = fixture();
    const resources = { cpus: 8, memoryBytes: 32 * 1024 ** 3, availableCpus: 3, availableMemoryBytes: 12 * 1024 ** 3 };
    let calls = 0;
    const api = httpApi(
      Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          expect(body.resources).toEqual(resources);
          expect(body.retentionSeconds).toBe(86400);
          expect(body.diskFreeBytes).toBe(123);
          if (unsupported in body || (unsupported === "resumeClaimProtocol" && "deadlines" in body)) {
            if (unsupported === "stoppedSandboxBytes") expect(body.stoppedSandboxBytes).toBe(456);
            return new Response(null, { status: 400 });
          }
          return Response.json({ job: null, retentionSeconds: 3600 });
        },
        { preconnect: fetch.preconnect },
      ),
      async () => resources,
      async () => 123,
      async () => 456,
    );
    expect(await api.poll(await f.store.load())).toEqual({ job: null, retentionSeconds: 3600 });
    expect(calls).toBe(unsupported === "resumeClaimProtocol" ? 2 : 3);
  },
);

test.each([false, true])(
  "complete allocation loss reconciles durable admission (failed create: %s)",
  async (failed) => {
    const f = fixture();
    if (failed) f.failExecution();
    await tick(f.store, f.api, f.executor);
    let absent = false;
    let online = false;
    const reports: string[] = [];
    f.executor.isAbsent = async () => absent;
    f.executor.isStopped = async () => false;
    f.api.cleaned = async (_state, requestId) => {
      if (!online) throw Error("offline");
      reports.push(requestId);
    };
    f.deny();
    absent = true;
    await tick(f.store, f.api, f.executor).catch(() => {});
    expect((await f.store.load()).retention?.[0]?.deleted).toBe(true);
    online = true;
    await tick(f.store, f.api, f.executor).catch(() => {});
    await tick(f.store, f.api, f.executor).catch(() => {});
    expect(reports).toEqual([f.job.requestId]);
    expect((await f.store.load()).retention).toEqual([]);
    expect(f.executed).toEqual(["create"]);
  },
);
test.each(["stop", "create", "resume"] as const)(
  "compacting %s receipts before discovery preserves every generation across restart",
  async (operation) => {
    const f = fixture();
    const state = await f.store.load();
    state.retentionSeconds = 0;
    state.receipts = Array.from({ length: 3 }, () => ({
      operation,
      inputHash: "resume_input",
      requestId: crypto.randomUUID(),
      request: {
        ...f.job.request,
        sandboxId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        image: "x".repeat(400000),
      },
      outcome: "completed" as const,
      ...(operation === "stop" ? {} : { expired: true as const, expiryReported: true as const }),
    }));
    const expected = state.receipts.map((r) => r.request.generation).sort();
    const store: Store = {
      load: () => f.store.load(),
      async save(next) {
        compactReceipts(next);
        await f.store.save(next);
      },
    };
    await store.save(state); // Compaction happens before the first observation.
    const deleted: string[] = [];
    const executor: Executor = {
      ...f.executor,
      isStopped: async () => true,
      deleteStopped: async (request) => {
        deleted.push(request.generation);
      },
    };
    const api: Api = { ...f.api, poll: async () => ({ job: null }) };
    // Each tick reloads a serialized state, just like a restarted daemon.
    for (let i = 0; i < 3; i++) await tick(store, api, executor, false, () => 1000);
    expect(deleted.sort()).toEqual(expected);
  },
);

test("expiry report compaction preserves an unobserved allocation across restart", async () => {
  const f = fixture();
  const state = await f.store.load();
  state.retentionSeconds = 0;
  state.receipts = [0, 1].map(() => ({
    operation: "create" as const,
    requestId: crypto.randomUUID(),
    request: {
      ...f.job.request,
      sandboxId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      image: "x".repeat(600000),
    },
    outcome: "completed" as const,
    expired: true as const,
  }));
  const expected = state.receipts.map((r) => r.request.generation).sort();
  await f.store.save(state);
  const store: Store = {
    load: () => f.store.load(),
    async save(next) {
      compactReceipts(next);
      await f.store.save(next);
    },
  };
  const deleted: string[] = [];
  let observed = false;
  const executor: Executor = {
    ...f.executor,
    isStopped: async () => observed,
    deleteStopped: async (request) => {
      deleted.push(request.generation);
    },
  };
  const api: Api = { ...f.api, poll: async () => ({ job: null }), result: async () => {} };
  await tick(store, api, executor, false, () => 1000);
  expect((await store.load()).receipts.some((r) => r.expiryReported)).toBe(true);
  observed = true;
  for (let i = 0; i < 2; i++) await tick(store, api, executor, false, () => 1000);
  expect(deleted.sort()).toEqual(expected);
});

test("physical expiry stops every generation while create is stalled without racing state persistence", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const second = fixture();
  await f.store.save({
    ...f.state(),
    activeTtl: [f.job.requestId, second.job.requestId],
    receipts: [
      ...f.state().receipts,
      { requestId: second.job.requestId, request: second.job.request, operation: "create", outcome: "completed" },
    ],
  });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const slowInspection = Promise.withResolvers<void>();
  const blocked = fixture();
  f.api.poll = async () => ({ job: blocked.job });
  f.executor.create = async () => {
    started.resolve();
    await finish.promise;
  };
  const pending = tick(f.store, f.api, f.executor);
  await started.promise;
  const before = structuredClone(f.state());
  const stopped: string[] = [];
  let time = 0;
  let checks = 0;
  let blockedChecks = 0;
  const observed = Promise.withResolvers<void>();
  f.executor.stopIfExpired = async (request) => {
    if (request.generation === blocked.job.request.generation) {
      blockedChecks++;
      await slowInspection.promise;
    }
    checks++;
    if (time >= 5) stopped.push(request.generation);
    if (request.generation === second.job.request.generation) observed.resolve();
    return true;
  };
  const expiry = createPhysicalExpirySweep(f.store, f.executor);
  await expiry.sweep();
  await observed.promise;
  expect(stopped).toEqual([]);
  expect(f.state()).toEqual(before);
  // Settle fast inspections without releasing the blocked allocation.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(checks).toBe(2);
  const newlyAdmitted = fixture();
  const updated = await f.store.load();
  updated.receipts.push({
    inputHash: "resume_input",
    requestId: newlyAdmitted.job.requestId,
    request: newlyAdmitted.job.request,
    operation: "resume",
    outcome: "completed",
  });
  updated.activeTtl?.push(newlyAdmitted.job.requestId);
  await f.store.save(updated);
  const afterAdmission = structuredClone(f.state());
  time = 10;
  await expiry.sweep();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(checks).toBe(5);
  expect(blockedChecks).toBe(1);
  expect(stopped).toContain(newlyAdmitted.job.request.generation);
  expect(stopped).toContain(f.job.request.generation);
  expect(stopped).toContain(second.job.request.generation);
  expect(f.state()).toEqual(afterAdmission);
  slowInspection.resolve();
  await expiry.drain();
  finish.resolve();
  await pending;
  // Only the serialized mailbox persists and publishes the physical proof.
  await tick(f.store, f.api, f.executor);
  expect(f.state().receipts.find((r) => r.requestId === second.job.requestId)?.expired).toBe(true);
});

test("compaction retires reconciled absence without dropping undiscovered allocations", async () => {
  const f = fixture();
  const state = await f.store.load();
  state.receipts = [true, false].map((cleaned) => ({
    requestId: crypto.randomUUID(),
    operation: "create" as const,
    outcome: "completed" as const,
    expired: true as const,
    expiryReported: true as const,
    ...(cleaned ? { cleaned: true as const } : {}),
    request: {
      ...f.job.request,
      generation: crypto.randomUUID(),
      image: "x".repeat(600000),
    },
  }));
  const [reconciled, undiscovered] = state.receipts;
  compactReceipts(state);
  expect(state.receipts.map((r) => r.requestId)).toEqual([undiscovered!.requestId]);
  expect(state.retired?.map((r) => r[0])).toEqual([reconciled!.requestId]);
});

test("a queued resume is observed before a due local retention deletion", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const order: string[] = [];
  const executor: Executor = {
    ...f.executor,
    async resume() {
      order.push("resume");
    },
    async deleteStopped() {
      order.push("delete");
    },
    startRuntime: async () => {
      order.push("startRuntime");
    },
  };
  const state = await f.store.load();
  state.retention = [{ request: f.job.request, requestId: f.job.requestId, deadline: 0 }];
  await f.store.save(state);
  const resume: Job = {
    requestId: crypto.randomUUID(),
    operation: "resume",
    request: f.job.request,
    bootstrap: {
      serverUrl: "https://armada.example",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: `armada_enrol_${"c".repeat(64)}`,
    },
  };
  f.api.poll = async () => {
    order.push("poll");
    return { job: resume };
  };
  await tick(f.store, f.api, executor, false, () => 0);
  // The resume claims the stopped generation before retention may delete it.
  expect(order).toEqual(["poll", "resume", "startRuntime"]);
  expect((await f.store.load()).retention).toEqual([]);
});

test("a resume does not drop an already deleted entry's pending cleaned report", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const state = await f.store.load();
  state.retention = [{ request: f.job.request, requestId: f.job.requestId, deadline: 0, deleted: true }];
  await f.store.save(state);
  const reports: string[] = [];
  const resume: Job = {
    requestId: crypto.randomUUID(),
    operation: "resume",
    request: f.job.request,
    bootstrap: {
      serverUrl: "https://armada.example",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: `armada_enrol_${"c".repeat(64)}`,
    },
  };
  f.api.poll = async () => ({ job: resume });
  f.api.cleaned = async (_state, requestId) => {
    reports.push(requestId);
  };
  await tick(f.store, f.api, f.executor, false, () => 0);
  expect(reports).toEqual([f.job.requestId]);
  expect((await f.store.load()).retention).toEqual([]);
});

test("a resume behind another mailbox job still cancels its generation's due retention deletion", async () => {
  const f = fixture();
  await tick(f.store, f.api, f.executor);
  const order: string[] = [];
  const executor: Executor = {
    ...f.executor,
    async resume() {
      order.push("resume");
    },
    async deleteStopped() {
      order.push("delete");
    },
    async stop() {
      order.push("stop");
    },
    startRuntime: async () => {
      order.push("startRuntime");
    },
  };
  const state = await f.store.load();
  state.retention = [{ request: f.job.request, requestId: f.job.requestId, deadline: 0 }];
  await f.store.save(state);
  const resume: Job = {
    requestId: crypto.randomUUID(),
    operation: "resume",
    request: f.job.request,
    bootstrap: {
      serverUrl: "https://armada.example",
      artifact: { sha256: "b".repeat(64), bytes: 123 },
      enrolmentToken: `armada_enrol_${"c".repeat(64)}`,
    },
  };
  // The server serves one job per poll, ordered so every stop/delete precedes
  // startup work. An unrelated stop is therefore handed out first, and the
  // resume for this generation is only visible as pending intent.
  const unrelated: Job = {
    requestId: crypto.randomUUID(),
    operation: "stop",
    request: { ...f.job.request, sandboxId: crypto.randomUUID(), generation: crypto.randomUUID() },
  };
  let polls = 0;
  f.api.poll = async () => {
    order.push("poll");
    polls++;
    // The server reports every held generation with the poll, including a
    // resume queued behind this stop, not only the single job it hands out.
    return {
      job: polls === 1 ? unrelated : resume,
      pendingStarts: [{ sandboxId: resume.request.sandboxId, generation: resume.request.generation }],
    };
  };
  await tick(f.store, f.api, executor, false, () => 0);
  // The due generation is not deleted while a resume for it is queued behind the stop.
  expect(order).not.toContain("delete");
  expect((await f.store.load()).retention).toEqual([]);
});

test("an abandoned resume claim releases at immutable expiry for default cleanup", async () => {
  const f = fixture();
  f.job.request.expiresAt = 1000;
  await tick(f.store, f.api, f.executor, false, () => 0);
  const state = await f.store.load();
  state.retentionSeconds = 1;
  state.retention = [{ request: f.job.request, requestId: f.job.requestId, deadline: 10 }];
  await f.store.save(state);
  const requestId = crypto.randomUUID();
  let offline = false;
  const acknowledgements: boolean[] = [];
  let deleted = false;
  f.api.poll = async () => {
    if (offline) throw Error("offline");
    return {
      job: null,
      pendingStarts: [{ sandboxId: f.job.request.sandboxId, generation: f.job.request.generation }],
      resumeClaims: [{ requestId, sandboxId: f.job.request.sandboxId, generation: f.job.request.generation }],
    };
  };
  f.api.claim = async (_state, _requestId, accepted) => {
    acknowledgements.push(accepted);
  };
  f.executor.isStopped = async () => true;
  f.executor.deleteStopped = async () => {
    deleted = true;
  };
  await tick(f.store, f.api, f.executor, false, () => 9);
  expect(acknowledgements).toEqual([true]);
  offline = true;
  await expect(tick(f.store, f.api, f.executor, false, () => 999)).rejects.toThrow("offline");
  expect((await f.store.load()).retention).toEqual([]);
  // A fresh load on each tick represents restart; expiry retires the durable
  // hold, then default discovery reclaims the expired workspace.
  await expect(tick(f.store, f.api, f.executor, false, () => 1000)).rejects.toThrow("offline");
  expect((await f.store.load()).resumeClaims?.[0]?.active).toBe(false);
  expect((await f.store.load()).retention?.[0]?.deadline).toBe(1000);
  expect(deleted).toBe(true);
  const compacted = await f.store.load();
  const original = compacted.receipts.find((receipt) => receipt.requestId === f.job.requestId)!;
  original.expired = true;
  original.expiryReported = true;
  // A completed unrelated snapshot supplies the ledger pressure that triggers
  // real compaction; its opaque image bytes are never sent to Docker.
  compacted.receipts.push({
    requestId: crypto.randomUUID(),
    operation: "buildSnapshot",
    inputHash: "c".repeat(64),
    request: { ...f.job.request, sandboxId: crypto.randomUUID(), image: "x".repeat(1100000) },
    outcome: "completed",
  });
  compactReceipts(compacted);
  expect(compacted.receipts.some((receipt) => receipt.requestId === f.job.requestId)).toBe(false);
  await f.store.save(compacted);
  offline = false;
  await tick(f.store, f.api, f.executor, false, () => 1999);
  expect(acknowledgements).toEqual([true]); // expired replays cannot renew the claim
  expect(deleted).toBe(true);
  offline = true;
  await expect(tick(f.store, f.api, f.executor, false, () => 2000)).rejects.toThrow("offline");
  expect(deleted).toBe(true);
});

test("disk pressure reclaims oldest eligible workspaces until the floor, preserving claims and uncertain ownership", async () => {
  const f = fixture();
  const state = await f.store.load();
  const requests = Array.from({ length: 7 }, () => ({
    ...f.job.request,
    sandboxId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
  }));
  state.receipts = requests.map((request) => ({
    requestId: crypto.randomUUID(),
    request,
    operation: "stop",
    outcome: "completed",
  }));
  state.retention = state.receipts.map((receipt, i) => ({
    request: receipt.request,
    requestId: receipt.requestId,
    deadline: 10000 + i,
  }));
  state.resumeClaims = [{ requestId: crypto.randomUUID(), ...requests[0]!, accepted: true, active: true }];
  await f.store.save(state);
  f.api.poll = async () => ({ job: null, pendingStarts: [requests[1]!] });
  let free = 1;
  const removed: string[] = [];
  f.executor.diskFreeBytes = async () => free;
  f.executor.stoppedAt = async (request) => (request.generation === requests[5]!.generation ? 1 : 2);
  f.executor.isStopped = async (request) => {
    if (request === undefined) throw Error("missing request");
    if (request.generation === requests[2]!.generation) throw Error("foreign ownership");
    return request.generation !== requests[3]!.generation; // running/starting
  };
  f.executor.deleteStopped = async (request) => {
    expect(
      (await f.store.load()).retention?.find((entry) => entry.request.generation === request.generation)
        ?.cleanupAuthorized,
    ).toBe(true);
    removed.push(request.generation);
    if (removed.length === 2) free = 10_000_000_000;
  };
  await tick(f.store, f.api, f.executor, false, () => 100);
  expect(removed).toEqual([requests[5]!.generation, requests[4]!.generation]);
  expect(
    (await f.store.load()).retention?.filter((entry) => entry.deleted).map((entry) => entry.cleanupReason),
  ).toEqual(["disk_pressure", "disk_pressure"]);
});

test("failed pressure image cleanup cannot suppress durable workspace-loss reporting", async () => {
  const f = fixture();
  const state = await f.store.load();
  state.retention = [
    { request: f.job.request, requestId: f.job.requestId, deadline: 0, deleted: true, cleanupReason: "disk_pressure" },
  ];
  await f.store.save(state);
  f.api.poll = async () => ({ job: null });
  f.executor.diskFreeBytes = async () => 0;
  f.executor.cleanupImages = async () => {
    throw Error("inventory unavailable");
  };
  const reasons: (string | undefined)[] = [];
  f.api.cleaned = async (_state, _id, reason) => {
    reasons.push(reason);
  };
  await tick(f.store, f.api, f.executor, false, () => 100);
  expect(reasons).toEqual(["disk_pressure"]);
  expect((await f.store.load()).retention).toEqual([]);
});

test("the mailbox loop drains ready jobs without idling and runs another sandbox's job while one executes", async () => {
  const a = fixture();
  const b = fixture();
  let state = a.state();
  const store: Store = {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
  const queue = [a.job, b.job];
  const acknowledged: string[] = [];
  const polls: { waitSeconds: number | undefined; running: string[] | undefined }[] = [];
  let changed = Promise.withResolvers<void>();
  const api: Api = {
    async register() {
      throw new Error("unused");
    },
    async poll(_state, options) {
      polls.push({ waitSeconds: options?.waitSeconds, running: options?.running });
      const job = queue.find(
        (item) => !acknowledged.includes(item.requestId) && !options?.running?.includes(item.requestId),
      );
      if (job) return { job: structuredClone(job), held: true };
      // The server holds the poll until something changes.
      await changed.promise;
      return { job: null, held: true };
    },
    async result(_state, receipt) {
      acknowledged.push(receipt.requestId);
      changed.resolve();
      changed = Promise.withResolvers<void>();
    },
  };
  const releaseFirst = Promise.withResolvers<void>();
  let firstPendingWhileSecondRan = false;
  const finished = new Set<string>();
  const executor: Executor = {
    async create(request) {
      if (request.sandboxId === a.job.request.sandboxId) await releaseFirst.promise;
      else {
        firstPendingWhileSecondRan = !finished.has(a.job.request.sandboxId);
        releaseFirst.resolve();
      }
      finished.add(request.sandboxId);
    },
    stop: async () => {},
    delete: async () => {},
    stopIfExpired: async () => {},
  };
  const sleeps: number[] = [];
  await runJobs(store, api, executor, {
    stopping: () => acknowledged.length === 2,
    async sleep(ms) {
      sleeps.push(ms);
    },
  });
  expect(firstPendingWhileSecondRan).toBe(true);
  expect(sleeps).toEqual([]);
  expect(polls[0]).toEqual({ waitSeconds: 20, running: [] });
  expect(polls[1]).toEqual({ waitSeconds: 20, running: [a.job.requestId] });
  expect(state.receipts.map((receipt) => receipt.outcome)).toEqual(["completed", "completed"]);
});

test("runJobs admits the job a held poll returns once its sandbox's running job completed during the hold", async () => {
  const request = {
    sandboxId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    image: `debian@sha256:${"a".repeat(64)}`,
    ttlSeconds: 60,
  };
  const create: Job = { requestId: crypto.randomUUID(), operation: "create", request };
  const stop: Job = { requestId: crypto.randomUUID(), operation: "stop", request };
  let state: State = {
    server: "https://armada.example",
    installationId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    hostToken: "a".repeat(64),
    receipts: [],
  };
  const store: Store = {
    load: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone(next);
    },
  };
  const acknowledged: string[] = [];
  let changed = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const api: Api = {
    async register() {
      throw new Error("unused");
    },
    // Like the server: a sandbox is blocked only until its running job's outcome is recorded.
    async poll(_state, options) {
      const running = options?.running ?? [];
      if (running.length) held.resolve();
      for (;;) {
        const blocked = (job: Job) =>
          [create, stop].some(
            (other) =>
              running.includes(other.requestId) &&
              !acknowledged.includes(other.requestId) &&
              other.request.sandboxId === job.request.sandboxId,
          );
        const job = [create, stop].find((item) => !acknowledged.includes(item.requestId) && !blocked(item));
        if (job) {
          delivered.push(job.requestId);
          return { job: structuredClone(job), held: true };
        }
        if (acknowledged.length === 2) return { job: null, held: true };
        await changed.promise;
      }
    },
    async result(_state, receipt) {
      acknowledged.push(receipt.requestId);
      changed.resolve();
      changed = Promise.withResolvers<void>();
    },
  };
  const executor: Executor = {
    // The create completes while the next poll is held, which then returns the stop.
    create: async () => held.promise,
    stop: async () => {},
    delete: async () => {},
    stopIfExpired: async () => {},
  };
  const sleeps: number[] = [];
  await runJobs(store, api, executor, {
    stopping: () => acknowledged.length === 2,
    async sleep(ms) {
      sleeps.push(ms);
    },
  });
  expect(sleeps).toEqual([]);
  expect(acknowledged).toEqual([create.requestId, stop.requestId]);
  // The stop is admitted from the hold that returned it, not refused and polled for again.
  expect(delivered).toEqual([create.requestId, stop.requestId]);
  expect(state.receipts.map((receipt) => receipt.outcome)).toEqual(["completed", "completed"]);
});

test("a re-delivered job that is still executing here is neither run again nor recovered as uncertain", async () => {
  const f = fixture();
  const api: Api = {
    ...f.api,
    poll: async (state, options) => ({ ...(await f.api.poll(state, options)), held: true }),
  };
  let work: Promise<void> | undefined;
  expect(
    await tick(f.store, api, f.executor, false, Date.now, {
      dispatch: (_job, running) => {
        work = running;
      },
    }),
  ).toBe("worked");
  expect(await tick(f.store, api, f.executor, false, Date.now, { running: new Set([f.job.requestId]) })).toBe("busy");
  await work;
  expect(f.executed).toEqual(["create"]);
  expect(f.acknowledgements).toEqual(["completed"]);
});

test("against a server that cannot hold a poll, jobs run serially and none is admitted beside running work", async () => {
  const f = fixture();
  const dispatched: string[] = [];
  const dispatch = (job: Job) => {
    dispatched.push(job.requestId);
  };
  // The older server answers without `held` and knows nothing of `running`.
  expect(await tick(f.store, f.api, f.executor, false, Date.now, { dispatch })).toBe("worked");
  expect(dispatched).toEqual([]);
  expect(f.acknowledgements).toEqual(["completed"]);
  const other = crypto.randomUUID();
  const receipts = f.state().receipts.length;
  expect(await tick(f.store, f.api, f.executor, false, Date.now, { dispatch, running: new Set([other]) })).toBe("busy");
  expect(f.state().receipts).toHaveLength(receipts);
  expect(f.executed).toEqual(["create"]);
  expect(f.acknowledgements).toEqual(["completed"]);
});

test("native held polls report running work and fall back to the previous protocol on older servers", async () => {
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  const api = httpApi(
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if ("waitSeconds" in body) return new Response(null, { status: 400 });
        return Response.json({ job: null });
      },
      { preconnect: fetch.preconnect },
    ),
    async () => ({ cpus: 8, memoryBytes: 32 * 1024 ** 3 }),
  );
  const running = crypto.randomUUID();
  expect(await api.poll(await f.store.load(), { skipSnapshots: true, waitSeconds: 20, running: [running] })).toEqual({
    job: null,
  });
  expect(bodies[0]).toMatchObject({ waitSeconds: 20, running: [running], resumeClaimProtocol: 1 });
  // A held poll leaves snapshot serialization to `running`: the flag would stay stale for the hold.
  expect(bodies[0]).not.toHaveProperty("skipSnapshots");
  expect(bodies[1]).toMatchObject({ resumeClaimProtocol: 1, skipSnapshots: true });
  expect(bodies[1]).not.toHaveProperty("waitSeconds");
  expect(bodies[1]).not.toHaveProperty("running");
  expect(bodies).toHaveLength(2);
});

test("a ledger that cannot be saved before a held poll never overwrites a completion saved during it", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const executor: Executor = {
    ...f.executor,
    async create(request) {
      await gate.promise;
      await f.executor.create(request);
    },
  };
  let failNextSave = false;
  const store: Store = {
    load: () => f.store.load(),
    async save(next) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("disk unavailable");
      }
      await f.store.save(next);
    },
  };
  let work: Promise<void> | undefined;
  let lostAck = true;
  const api: Api = {
    ...f.api,
    async poll(state, options) {
      if (options?.running?.length) {
        // The running job completes durably while this poll is held; its ACK is lost.
        gate.resolve();
        await work?.catch(() => {});
        return { job: null, held: true };
      }
      return { ...(await f.api.poll(state, options)), held: true };
    },
    async result(state, receipt, ...rest) {
      if (lostAck) {
        lostAck = false;
        throw new Error("ACK lost");
      }
      await f.api.result(state, receipt, ...rest);
    },
  };
  const dispatch = (_job: Job, running: Promise<void>) => {
    work = running;
  };
  expect(await tick(store, api, executor, false, Date.now, { dispatch })).toBe("worked");
  // The pre-poll save fails once; the completion's own save during the poll succeeds.
  failNextSave = true;
  const blocked = tick(store, api, executor, false, Date.now, { dispatch, running: new Set([f.job.requestId]) });
  await expect(blocked).rejects.toThrow("disk unavailable");
  gate.resolve();
  await expect(work).rejects.toThrow("ACK lost");
  // A tick with a ledger it could not save admitted nothing and wrote nothing afterwards.
  expect(f.state().receipts.find((receipt) => receipt.requestId === f.job.requestId)?.outcome).toBe("completed");
  // The re-delivered job replays its durable outcome instead of running again.
  expect(await tick(store, api, executor, false, Date.now, { dispatch })).toBe("worked");
  await work;
  expect(f.executed).toEqual(["create"]);
  expect(f.acknowledgements).toEqual(["completed"]);
});

test("a job of a sandbox whose operation still runs here waits, even if the server already freed the sandbox", async () => {
  // The server records an outcome without the host when it cancels queued work,
  // and then hands out the sandbox's next job while its create still executes.
  const f = fixture("stop");
  const api: Api = {
    ...f.api,
    poll: async (state, options) => ({ ...(await f.api.poll(state, options)), held: true }),
  };
  const running = new Set([crypto.randomUUID()]);
  const options = { running, sandboxes: new Set([f.job.request.sandboxId]), dispatch: () => {} };
  expect(await tick(f.store, api, f.executor, false, Date.now, options)).toBe("busy");
  expect(f.state().receipts).toEqual([]);
  expect(f.executed).toEqual([]);
});

test("retention never removes a generation whose delete still runs here, under disk pressure or a due deadline", async () => {
  const f = fixture();
  const state = await f.store.load();
  const deleteId = crypto.randomUUID();
  state.receipts = [
    { requestId: crypto.randomUUID(), request: f.job.request, operation: "stop", outcome: "completed" },
    { requestId: deleteId, request: f.job.request, operation: "delete" },
  ];
  state.retention = [{ request: f.job.request, requestId: state.receipts[0]!.requestId, deadline: 0 }];
  await f.store.save(state);
  f.api.poll = async () => ({ job: null, held: true });
  f.executor.diskFreeBytes = async () => 1;
  f.executor.isStopped = async () => true;
  const removed: string[] = [];
  f.executor.deleteStopped = async (request) => {
    removed.push(request.generation);
  };
  await tick(f.store, f.api, f.executor, false, () => 100, { waitSeconds: 20, running: new Set([deleteId]) });
  expect(removed).toEqual([]);
  // Once the delete is no longer running here, retention may clean the generation up.
  await tick(f.store, f.api, f.executor, false, () => 100, { waitSeconds: 20, running: new Set() });
  expect(removed).toEqual([f.job.request.generation]);
});
