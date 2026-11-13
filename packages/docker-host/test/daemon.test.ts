import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerMachineExecutor } from "../../core/src/docker-machine.ts";
import { type Api, type Executor, type Job, register, type State, type Store, tick } from "../src/daemon.ts";
import { fileStore, httpApi } from "../src/native.ts";

function fixture(operation: Job["operation"] = "create") {
  const job: Job = {
    requestId: crypto.randomUUID(),
    operation,
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
  let failure = false;
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
    executed.push(operation);
    if (failure) throw new Error("uncertain side effect");
  };
  const executor: Executor = {
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
    failExecution: () => {
      failure = true;
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

test("offline tick stops an expired owned Docker machine without exposing the host credential in argv", async () => {
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
  await expect(tick(f.store, f.api, executor)).rejects.toThrow("denied");
  expect(running).toBe(false);
  expect(JSON.stringify(calls)).not.toContain(state.hostToken);
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
  await api.result(state, { ...f.job, outcome: "completed" });
  expect(calls.map((c) => c.init.headers)).toEqual([
    { authorization: `Bearer ${registrationToken}`, "content-type": "application/json" },
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
    const release = await store.lock();
    await expect(store.lock()).rejects.toThrow();
    await release();
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
      receipts: Array.from({ length: 100_000 }, () => ({ ...f.job, outcome: "completed" as const })),
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
