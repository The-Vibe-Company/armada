import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapDescriptor } from "../../core/src/docker-host-job.ts";
import { createDockerMachineExecutor, DockerMachineError } from "../../core/src/docker-machine.ts";
import { type Api, type Executor, type Job, register, type State, type Store, tick } from "../src/daemon.ts";
import { fileStore, httpApi } from "../src/native.ts";

function fail(): never {
  throw new Error("missing receipt");
}

function fixture(
  operation: Exclude<Job["operation"], "bootstrap" | "resume"> = "create",
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

test("all physical TTL stops precede bounded fair reporting across restarted ticks", async () => {
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
  expect(sweepCounts).toEqual([2, 4, 6]);
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
