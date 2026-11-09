import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentEvent, Sql } from "@armada/core";
import { createSqlVaultStore, GoldenBuildJobs } from "@armada/core/server";
import type { Image, ModalClient, Sandbox } from "modal";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { type Driver, Journal, Runner } from "../../agent-runtime/src/index.ts";
import { createSandboxLifecycle } from "../../mcp-server/src/sandbox-lifecycle.ts";
import {
  appendModalEvents,
  type ComposedModalOptions,
  createComposedModalProvider,
  createModalIngestHandler,
  createModalProvider,
  createRunnerTransport,
  createSqlModalStore,
  type Machine,
  type ModalManagementAuthority,
  type ModalProviderOptions,
  mergeModalResourceReceipts,
  modalFailureReceipt,
  type RunnerDistribution,
  type Scope,
} from "../src/index.ts";

let db: Awaited<ReturnType<typeof openDatabase>>;
const scope: Scope = {
  orgId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  visibility: "private",
  binding: { workspace: "label-only", environment: "main", appId: "ap_pinned" },
};
beforeAll(async () => {
  db = await openDatabase();
  await applyMigrations(db);
  await db.query("insert into auth.users(id) values($1)", [scope.userId]);
  await db.query("insert into auth.users(id) values($1)", ["00000000-0000-0000-0000-000000000004"]);
  await db.query("insert into orgs(id,name) values($1,'modal')", [scope.orgId]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [scope.orgId, scope.userId]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [
    scope.orgId,
    "00000000-0000-0000-0000-000000000004",
  ]);
});
afterAll(async () => {
  await db.close();
});
function fixture(accessScope: Scope = scope, sql: Sql = db, beforePrompt?: ModalProviderOptions["beforePrompt"]) {
  const store = createSqlModalStore(sql, accessScope);
  const log: string[] = [];
  let creates = 0;
  const resourceRequests: Record<string, unknown>[] = [];
  let failSnapshot = false;
  let failCreate = false;
  let failBoot = false;
  let appId = "ap_pinned";
  let lookupError: Error | undefined;
  let onLookup: (() => Promise<void>) | undefined;
  let onScrub: (() => Promise<void>) | undefined;
  let onRpc: ((row: Machine, op: string, input: object) => Promise<unknown>) | undefined;
  let provisioned = false;
  let ownershipOverride: Record<string, string> | undefined;
  const bootstraps = new Map<string, { grant: { token: string; generation: string } }>();
  const machines = new Map<string, { sb: Sandbox; exit: number | null }>();
  const names = new Map<string, Sandbox>();
  const client = {
    apps: {
      fromName: async (_name: string, params: object) => {
        expect(params).toEqual({ environment: "main", createIfMissing: false });
        return { appId };
      },
    },
    images: {
      fromRegistry: () => ({ dockerfileCommands: () => ({ imageId: "im_base" }) }),
      fromId: async (id: string) => ({ imageId: id }),
      delete: async () => {
        log.push("delete-image");
      },
    },
    sandboxes: {
      create: async (
        _app: unknown,
        _image: unknown,
        params: { name: string; env: object; secrets: unknown[]; tags: Record<string, string> },
      ) => {
        creates++;
        resourceRequests.push({ ...params });
        expect(params.env).toEqual({});
        expect(params.secrets).toEqual([]);
        const id = `sb_${crypto.randomUUID()}`;
        const state = { sb: {} as Sandbox, exit: null as number | null };
        state.sb = {
          sandboxId: id,
          poll: async () => state.exit,
          getTags: async () => ownershipOverride ?? params.tags,
          createConnectToken: async () => ({ url: `https://runner.example/${id}`, token: "synthetic-connect" }),
          exec: async () => {
            let input: Record<string, unknown> | undefined;
            const closed = deferred();
            return {
              stdin: {
                writeText: async (text: string) => {
                  input = JSON.parse(text);
                  if (input && "command" in input) log.push("root-exec");
                  if (input && "grant" in input)
                    bootstraps.set(id, input as unknown as { grant: { token: string; generation: string } });
                },
                close: async () => {
                  closed.resolve();
                },
              },
              stdout: {
                readText: async () => {
                  await closed.promise;
                  return input?.op === "capture"
                    ? JSON.stringify({
                        version: 1,
                        physicalId: input.physicalId,
                        generation: input.generation,
                        namespace: { pid: "pid:[fixture]", mount: "mnt:[fixture]" },
                        processes: [{ pid: 1, start: "1" }],
                      })
                    : input && "command" in input
                      ? JSON.stringify({
                          detached: false,
                          exitCode: 0,
                          stdout: "",
                          stderr: "",
                          timedOut: false,
                          truncated: false,
                        })
                      : "";
                },
              },
              wait: async () => 0,
            };
          },
          snapshotFilesystem: async (p: object) => {
            expect(p).toEqual({ ttlMs: null });
            log.push("snapshot");
            expect(provisioned).toBe(false);
            if (failSnapshot) throw new Error("synthetic private SDK data");
            return { imageId: `im_${id}` };
          },
          terminate: async () => {
            log.push("terminate");
            state.exit = 0;
          },
        } as unknown as Sandbox;
        machines.set(id, state);
        names.set(params.name, state.sb);
        if (failCreate) throw new Error("lost create response");
        return state.sb;
      },
      fromId: async (id: string) => machines.get(id)?.sb,
      fromName: async (_app: string, name: string, params: object) => {
        expect(_app).toBe("pinned");
        expect(params).toEqual({ environment: accessScope.binding.environment, includeTerminated: true });
        await onLookup?.();
        if (lookupError) throw lookupError;
        const sb = names.get(name);
        if (!sb) throw Object.assign(new Error("synthetic absent"), { name: "NotFoundError" });
        return sb;
      },
    },
    close: () => {},
  } as unknown as ModalClient;
  const capabilities = {
    steer: "native" as const,
    interrupt: true,
    resume: true,
    parallelConversations: true,
    reasoningEffort: true,
    fast: true,
    streamsPartials: true,
    toolEvents: true,
    approvals: false,
  };
  const distribution: RunnerDistribution = {
    capabilities: { claude: capabilities, codex: { ...capabilities, steer: "restart" } },
    image: async () => ({ imageId: "im_base" }) as Image,
    start: async (_sb, row, env) => {
      log.push(`start-${row.generation}`);
      if (failBoot) throw Error("synthetic boot failure; never log request/env");
      expect(Object.keys(env)).not.toContain("MODAL_TOKEN_SECRET");
    },
    prepareFreshMachine: async (_sandbox, row) => {
      log.push(`fresh-${row.generation}`);
    },
    restoreEnv: async () => ({}),
    prepareSnapshot: async () => {
      log.push("scrub");
      provisioned = false;
      await onScrub?.();
    },
  };
  const provider = createModalProvider({
    scope: accessScope,
    ...(beforePrompt ? { beforePrompt } : {}),
    tokenId: "synthetic-id",
    tokenSecret: "synthetic-secret",
    appName: "pinned",
    client,
    store,
    distribution,
    runner: {
      async call<T>(_row: Machine, op: string, input: object) {
        log.push(op);
        const override = await onRpc?.(_row, op, input);
        if (override !== undefined) return override as T;
        if (op === "configureMcp")
          return { revision: (input as { configuration: { revision: string } }).configuration.revision } as T;
        if (op === "exec") expect(input).toHaveProperty("input");
        if (op === "health") return { generation: String(_row.generation), ready: true } as T;
        if (op === "prompt")
          return { promptId: crypto.randomUUID(), conversationId: crypto.randomUUID(), status: "queued" } as T;
        return (
          op === "checkpoint" ? { watermark: 0, acknowledgedSequence: 0, generation: String(_row.generation) } : {}
        ) as T;
      },
    },
    ssh: {
      prepare: async (_sandbox, row) => {
        provisioned = true;
        return { endpoint: "example:22", hostPublicKey: "public", username: row.golden ? "root" : "user" };
      },
    },
  });
  return {
    provider,
    store,
    client,
    log,
    bootstraps,
    resourceRequests,
    get provisioned() {
      return provisioned;
    },
    onRpc(work: (row: Machine, op: string, input: object) => Promise<unknown>) {
      onRpc = work;
    },
    onScrub(work: () => Promise<void>) {
      onScrub = work;
    },
    onLookup(work: () => Promise<void>) {
      onLookup = work;
    },
    lookupError(error: Error | undefined) {
      lookupError = error;
    },
    ownership(value?: Record<string, string>) {
      ownershipOverride = value;
    },
    wrongOwnership() {
      ownershipOverride = { armada_sandbox: "somebody-else" };
    },
    get creates() {
      return creates;
    },
    failBoot(value: boolean) {
      failBoot = value;
    },
    failSnapshot(value: boolean) {
      failSnapshot = value;
    },
    failCreate(value: boolean) {
      failCreate = value;
    },
    wrongApp() {
      appId = "ap_other";
    },
  };
}
test("durable golden recovery persists an interrupted Modal builder before exact owned cleanup, never replays create", async () => {
  const f = fixture();
  const key = Buffer.alloc(32, 61).toString("base64");
  const actor = { userId: scope.userId, orgId: scope.orgId, role: "admin" as const };
  let concurrentAfterPersist: (() => Promise<void>) | undefined;
  const recoverySql: Sql = {
    query: db.query.bind(db),
    transaction: async (work) => {
      const result = await db.transaction(work);
      const run = concurrentAfterPersist;
      if (run) {
        const persisted = await db.query<{ builder_id: string | null }>(
          "select builder_id from golden_build_jobs where id=$1",
          [job.jobId],
        );
        if (persisted.rows[0]?.builder_id) {
          concurrentAfterPersist = undefined;
          await run();
        }
      }
      return result;
    },
  };
  const jobs = new GoldenBuildJobs({
    sql: recoverySql,
    encryptionKey: key,
    service: {
      github: { store: createSqlVaultStore(db), encryptionKey: key, app: null },
      installationApp: null,
      ssh: async () => {
        throw Error("Build commands must not replay");
      },
    },
    provider: async () => f.provider,
  });
  const job = await jobs.admit(
    f.provider,
    actor,
    { name: "lost-builder", visibility: "private", repos: ["acme/web"], modal: scope.binding },
    crypto.randomUUID(),
  );
  const fence = crypto.randomUUID();
  await db.query(
    "update golden_build_jobs set state='recovery_required',phase='builder',error_code='build_failed',fence=$2 where id=$1",
    [job.jobId, fence],
  );
  f.failCreate(true);
  await expect(
    f.provider.createGolden({ idempotencyKey: job.jobId, labels: { armada: "golden-builder" } }),
  ).rejects.toMatchObject({ code: "unknown" });
  const reserved = await f.store.findByRequestKey(job.jobId);
  if (!reserved) throw Error("Fixture reservation missing");
  const target = {
    provider: "modal" as const,
    orgId: scope.orgId,
    visibility: "private" as const,
    modal: scope.binding,
  };
  const request = { requestKey: job.jobId, ownerId: scope.userId, target };
  expect(await f.provider.findGoldenBuilder({ ...request, requestKey: crypto.randomUUID() })).toBeNull();
  await expect(
    f.provider.findGoldenBuilder({ ...request, ownerId: "00000000-0000-0000-0000-000000000004" }),
  ).rejects.toMatchObject({ code: "forbidden" });
  for (const modal of [
    { ...scope.binding, appId: "ap_other" },
    { ...scope.binding, environment: "other" },
    { ...scope.binding, workspace: "other" },
  ]) {
    await expect(f.provider.findGoldenBuilder({ ...request, target: { ...target, modal } })).rejects.toMatchObject({
      code: "forbidden",
    });
  }
  const row = async () =>
    (
      await db.query<{ builder_id: string | null; state: string; fence: string }>(
        "select builder_id,state,fence from golden_build_jobs where id=$1",
        [job.jobId],
      )
    ).rows[0]!;
  await expect(
    f.provider.findGoldenBuilder({ ...request, target: { ...target, orgId: "00000000-0000-0000-0000-000000000099" } }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    f.provider.findGoldenBuilder({ ...request, target: { ...target, visibility: "org" } }),
  ).rejects.toMatchObject({ code: "forbidden" });
  const originalRecord = structuredClone(reserved);
  for (const corrupt of [
    { ...originalRecord, golden: false },
    { ...originalRecord, managementAuthority: undefined },
    { ...originalRecord, managementAuthority: { credentialScope: "org", credentialOwnerId: scope.orgId } },
    { ...originalRecord, launchUserId: "00000000-0000-0000-0000-000000000004" },
  ]) {
    await db.query("update modal_machines set record=$2::jsonb where id=$1", [
      reserved.info.id,
      JSON.stringify(corrupt),
    ]);
    await expect(f.provider.findGoldenBuilder(request)).rejects.toMatchObject({ code: "forbidden" });
  }
  await db.query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify(originalRecord),
  ]);
  await db.query("update modal_machines set owner_id=$2 where id=$1", [
    reserved.info.id,
    "00000000-0000-0000-0000-000000000004",
  ]);
  expect(await f.provider.findGoldenBuilder(request)).toBeNull();
  await db.query("update modal_machines set owner_id=$2 where id=$1", [reserved.info.id, scope.userId]);
  const discover = f.provider.findGoldenBuilder;
  f.provider.findGoldenBuilder = async (req) => {
    const found = await discover(req);
    await db.query("update golden_build_jobs set fence=$2 where id=$1", [job.jobId, crypto.randomUUID()]);
    return found;
  };
  await jobs.reconcileOne();
  expect((await row()).builder_id).toBeNull();
  expect(f.log).not.toContain("terminate");
  await db.query("update golden_build_jobs set fence=$2 where id=$1", [job.jobId, fence]);
  f.provider.findGoldenBuilder = discover;
  for (const phase of ["snapshot", "persist"]) {
    await db.query("update golden_build_jobs set phase=$2 where id=$1", [job.jobId, phase]);
    await jobs.reconcileOne();
    expect((await row()).builder_id).toBeNull();
    expect(f.log).not.toContain("terminate");
  }
  await db.query("update golden_build_jobs set phase='builder' where id=$1", [job.jobId]);
  await db.query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify({ ...originalRecord, snapshotImages: [{ name: "retained-proof", imageId: "im_proof" }] }),
  ]);
  let concurrentTicks = 0;
  let retainedDiscoveries = 0;
  f.provider.findGoldenBuilder = async (req) => {
    retainedDiscoveries++;
    return discover(req);
  };
  concurrentAfterPersist = async () => {
    concurrentTicks++;
    await jobs.reconcileOne();
  };
  await jobs.reconcileOne();
  await jobs.reconcileOne();
  expect(concurrentTicks).toBe(1);
  expect(retainedDiscoveries).toBe(3);
  f.provider.findGoldenBuilder = discover;
  expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required" });
  expect(f.log).not.toContain("terminate");
  expect(f.log).not.toContain("delete-image");
  await db.query(
    "update modal_machines set record=$2::jsonb,lease_id=$3,lease_until=now()+interval '15 minutes' where id=$1",
    [reserved.info.id, JSON.stringify(originalRecord), crypto.randomUUID()],
  );
  await jobs.reconcileOne();
  expect((await row()).state).toBe("recovery_required");
  expect(f.log).not.toContain("terminate");
  await db.query("update modal_machines set lease_until=now()-interval '1 second' where id=$1", [reserved.info.id]);
  f.provider.findGoldenBuilder = async (req) => {
    const found = await discover(req);
    await db.query("update modal_machines set record=$2::jsonb where id=$1", [
      reserved.info.id,
      JSON.stringify({ ...originalRecord, recoveryImageId: "im_late_proof" }),
    ]);
    return found;
  };
  await jobs.reconcileOne();
  expect((await row()).state).toBe("recovery_required");
  expect(f.log).not.toContain("terminate");
  expect(f.log).not.toContain("delete-image");
  f.provider.findGoldenBuilder = discover;
  await db.query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify(originalRecord),
  ]);
  f.onLookup(async () => {
    expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required", fence });
  });
  for (const name of ["NotFoundError", "TimeoutError"]) {
    f.lookupError(Object.assign(new Error("synthetic SDK private payload"), { name }));
    await jobs.reconcileOne();
    expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required" });
    expect((await f.store.get(reserved.info.id)).phase).toBe("creating");
    expect(f.log).not.toContain("terminate");
  }
  f.lookupError(undefined);
  // A prior observation can have persisted a physical ID. That does not waive current tags.
  const known = await f.client.sandboxes.fromName("pinned", reserved.physicalName, {
    environment: "main",
    includeTerminated: true,
  });
  await db.query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify({ ...originalRecord, physicalId: known.sandboxId }),
  ]);
  for (const tag of ["armada_sandbox", "armada_scope", "armada_generation"]) {
    f.ownership({
      armada_sandbox: reserved.info.id,
      armada_scope: createHash("sha256")
        .update(
          JSON.stringify([
            scope.orgId,
            scope.visibility,
            scope.userId,
            scope.binding.workspace,
            scope.binding.environment,
            scope.binding.appId,
          ]),
        )
        .digest("hex"),
      armada_generation: "1",
      [tag]: "wrong",
    });
    await jobs.reconcileOne();
    expect((await row()).state).toBe("recovery_required");
    expect(f.log).not.toContain("terminate");
  }
  f.ownership();
  // A later named lookup succeeds: cleanup only, no SDK create retry or command execution.
  await jobs.reconcileOne();
  expect((await row()).state).toBe("failed");
  expect((await f.store.get(reserved.info.id)).phase).toBe("deleted");
  expect(f.creates).toBe(1);
  expect(f.log.filter((x) => x === "terminate")).toHaveLength(1);
  expect(f.log).not.toContain("root-exec");
  expect(f.log).not.toContain("snapshot");
  await jobs.reconcileOne();
  expect(f.creates).toBe(1);
  expect(f.log.filter((x) => x === "terminate")).toHaveLength(1);
});

// Authoring gate: SDK-bound resource requests, no-allocation rejection and restoration
// are provider-owned behavior; pure policy tests cannot detect dropped SDK options.
test.each([
  ["small", 1, 4096],
  ["medium", 2, 8192],
  ["large", 4, 16384],
  ["xlarge", 8, 32768],
] as const)("Modal %s pins physical-core and MiB requests and limits across resume", async (size, cpu, memoryMiB) => {
  const f = fixture();
  const builder = await f.provider.createGolden({});
  const name = crypto.randomUUID();
  await f.provider.snapshot({ sandboxId: builder.id, name });
  const row = await f.provider.fork({ from: name, size });
  const resources = { cpu, cpuLimit: cpu, memoryMiB, memoryLimitMiB: memoryMiB };
  expect(f.resourceRequests[1]).toMatchObject(resources);
  expect(f.resourceRequests[0]).not.toHaveProperty("cpu");
  expect(f.resourceRequests[0]).not.toHaveProperty("memoryMiB");
  await f.provider.stop({ sandboxId: row.id });
  await f.provider.exec({ sandboxId: row.id, command: "true" });
  expect(f.resourceRequests[2]).toMatchObject(resources);
  expect((await f.store.get(row.id)).size).toBe(size);
});

test("invalid Modal size is refused without a physical create", async () => {
  const f = fixture();
  await expect(f.provider.fork({ from: "not-looked-up", size: "default" as never })).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(f.creates).toBe(0);
});

async function runningFork(f: ReturnType<typeof fixture>) {
  const builder = await f.provider.createGolden({});
  const name = crypto.randomUUID();
  await f.provider.snapshot({ sandboxId: builder.id, name });
  return f.provider.fork({ from: name });
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function compositionOptions(
  f: ReturnType<typeof fixture>,
  target: Scope = scope,
  sourceScope: Scope = target,
): ComposedModalOptions {
  const bundle = new TextEncoder().encode("credential-free fixture bundle");
  return {
    scope: target,
    sourceScope,
    appName: "pinned",
    sql: db,
    signingKey: new Uint8Array(32).fill(23),
    ingestUrl: "https://ingest.example/api/v1/modal/events",
    client: f.client,
    artifact: {
      base: `node@sha256:${"a".repeat(64)}`,
      apt: { git: "1", gh: "1", opensshServer: "1", sudo: "1", caCertificates: "1", curl: "1", unzip: "1" },
      bundle,
      sha256: createHash("sha256").update(bundle).digest("hex"),
    },
    resolveHarnessEnvironment: async () => ({ claudeEnv: {}, codexEnv: {} }),
    fetcher: (async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const bootstrap = f.bootstraps.get(new URL(String(url)).pathname.slice(1));
      if (!bootstrap) throw Error("missing SDK bootstrap");
      expect(new Headers(init?.headers).get("x-armada-runner-grant")).toBe(bootstrap.grant.token);
      const result =
        request.op === "checkpoint"
          ? { generation: bootstrap.grant.generation, watermark: 0, acknowledgedSequence: 0 }
          : request.op === "configureMcp"
            ? { revision: request.configuration.revision, unsafeConfiguration: request.configuration }
            : request.op === "prompt"
              ? {
                  promptId: crypto.randomUUID(),
                  conversationId: request.input.conversationId ?? crypto.randomUUID(),
                  status: "queued",
                }
              : { generation: bootstrap.grant.generation, ready: true };
      return Response.json({ version: 1, requestId: request.requestId, result });
    }) as typeof fetch,
  };
}
describe("Modal lifecycle at SDK + durable SQL boundaries", () => {
  test("24h overflow and different App refuse before machine creation", async () => {
    const f = fixture();
    await expect(f.provider.createGolden({ ttlSeconds: 86401 })).rejects.toMatchObject({ code: "invalid_request" });
    f.wrongApp();
    await expect(f.provider.createGolden({})).rejects.toMatchObject({ code: "forbidden" });
    expect(f.creates).toBe(0);
  });
  test("unknown create response reconciles deterministic name without second create", async () => {
    const f = fixture();
    const key = crypto.randomUUID();
    f.failCreate(true);
    await expect(f.provider.createGolden({ idempotencyKey: key })).rejects.toMatchObject({ code: "unknown" });
    f.failCreate(false);
    const row = await f.provider.createGolden({ idempotencyKey: key });
    expect(row.state).toBe("ready");
    expect(f.creates).toBe(1);
  });
  test("delete reconciles a lost create response under the pinned App before changing creating phase", async () => {
    const f = fixture();
    const name = crypto.randomUUID();
    f.failCreate(true);
    await expect(f.provider.createGolden({ name })).rejects.toMatchObject({ code: "unknown" });
    const row = (await f.store.list()).find((x) => x.info.name === name);
    if (!row) throw Error("missing reservation");
    expect(row.phase).toBe("creating");
    expect(row.physicalId).toBeUndefined();
    f.onLookup(async () => {
      const current = await f.store.get(row.info.id);
      expect(current.phase).toBe("creating");
      expect(current.physicalId).toBeUndefined();
    });
    await expect(f.provider.delete({ sandboxId: row.info.id })).resolves.toMatchObject({ status: "deleted" });
    expect(f.log).toContain("terminate");
    expect(f.creates).toBe(1);
    expect((await f.store.get(row.info.id)).physicalId).toBeDefined();
    expect((await f.store.get(row.info.id)).phase).toBe("deleted");
  });
  test("SQL crashes before create are known absent, while crashes after SDK create reconcile ownership before delete", async () => {
    for (const crashPhase of ["creating", "booting"] as const) {
      let crash = true;
      const sql: Sql = {
        async query<T>(statement: string, params?: unknown[]) {
          const candidate = params?.[3];
          if (
            crash &&
            typeof candidate === "string" &&
            candidate.startsWith("{") &&
            JSON.parse(candidate).phase === crashPhase
          ) {
            crash = false;
            throw Error("injected durable commit loss");
          }
          return db.query<T>(statement, params);
        },
      };
      const f = fixture(scope, sql);
      const name = crypto.randomUUID();
      await expect(f.provider.createGolden({ name })).rejects.toMatchObject({ code: "unknown" });
      const row = (await f.store.list()).find((x) => x.info.name === name);
      if (!row) throw Error("missing reservation");
      expect(row.physicalId).toBeUndefined();
      expect(row.phase).toBe(crashPhase === "creating" ? "reserved" : "creating");
      f.onLookup(async () => {
        expect(crashPhase).toBe("booting");
        expect((await f.store.get(row.info.id)).phase).toBe("creating");
      });
      await f.provider.delete({ sandboxId: row.info.id });
      expect((await f.store.get(row.info.id)).phase).toBe("deleted");
      expect(f.creates).toBe(crashPhase === "creating" ? 0 : 1);
      expect(f.log.includes("terminate")).toBe(crashPhase === "booting");
    }
  });
  test("unknown/absent create lookup or foreign ownership preserves creating and never terminates a different machine", async () => {
    const f = fixture();
    const name = crypto.randomUUID();
    f.failCreate(true);
    await expect(f.provider.createGolden({ name })).rejects.toMatchObject({ code: "unknown" });
    const row = (await f.store.list()).find((x) => x.info.name === name);
    if (!row) throw Error("missing reservation");
    for (const error of [
      new Error("lookup offline"),
      Object.assign(new Error("no name yet"), { name: "NotFoundError" }),
    ]) {
      f.lookupError(error);
      await expect(f.provider.delete({ sandboxId: row.info.id })).rejects.toMatchObject({ code: "unavailable" });
      expect((await f.store.get(row.info.id)).phase).toBe("creating");
    }
    f.lookupError(undefined);
    f.wrongOwnership();
    await expect(f.provider.delete({ sandboxId: row.info.id })).rejects.toMatchObject({ code: "conflict" });
    expect((await f.store.get(row.info.id)).phase).toBe("creating");
    expect(f.log).not.toContain("terminate");
    expect(f.creates).toBe(1);
  });
  test("prepareSsh cannot reprovision authorization or a hostkey between snapshot scrub and save", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    await f.provider.sshKey({ sandboxId: row.id, key: "synthetic" });
    expect(f.provisioned).toBe(true);
    f.onScrub(async () => {
      expect(f.provisioned).toBe(false);
      await expect(f.provider.prepareSsh(row.id, "synthetic")).rejects.toMatchObject({ code: "sandbox_not_ready" });
      await expect(f.provider.sshKey({ sandboxId: row.id, key: "synthetic" })).rejects.toMatchObject({
        code: "sandbox_not_ready",
      });
      expect(f.provisioned).toBe(false);
    });
    await f.provider.snapshot({ sandboxId: row.id, name: crypto.randomUUID() });
    expect(f.log).toContain("snapshot");
    expect(f.provisioned).toBe(false);
  });
  test("snapshot failure never terminates or reports a durable stop", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    f.failSnapshot(true);
    await expect(f.provider.stop({ sandboxId: row.id })).rejects.toMatchObject({ code: "unknown" });
    expect(f.log).not.toContain("terminate");
    expect((await f.store.get(row.id)).phase).toBe("snapshot");
    await expect(f.provider.stop({ sandboxId: row.id })).rejects.toMatchObject({ code: "conflict" });
  });
  test("checkpoint, scrub, save, commit and terminate; resume retains logical ID with fenced new generation", async () => {
    const f = fixture();
    const row = await runningFork(f);
    await f.provider.stop({ sandboxId: row.id });
    expect(f.log.slice(-4)).toEqual(["checkpoint", "scrub", "snapshot", "terminate"]);
    const stopped = await f.store.get(row.id);
    expect(stopped.phase).toBe("stopped");
    expect(stopped.recoveryImageId).toBeDefined();
    await f.provider.exec({ sandboxId: row.id, command: "pwd" });
    const resumed = await f.store.get(row.id);
    expect(resumed.info.id).toBe(row.id);
    expect(resumed.generation).toBe(2);
    expect(resumed.physicalId).not.toBe(stopped.physicalId);
  });
  test("stopped prompt reads preserve durable outcomes without restoring compute", async () => {
    const f = fixture();
    const row = await runningFork(f);
    const statuses = ["queued", "running", "finished", "failed", "interrupted"] as const;
    await appendModalEvents(
      db,
      scope,
      row.id,
      "1",
      statuses.map((status, i) => ({
        sequence: i + 1,
        event: {
          id: `event-${i}`,
          at: i,
          kind: "prompt" as const,
          text: "task",
          promptId: `prompt-${i}`,
          conversationId: "conversation",
          status,
        },
      })),
    );
    f.onRpc(async (_row, op) =>
      op === "checkpoint" ? { watermark: 5, acknowledgedSequence: 5, generation: "1" } : undefined,
    );
    await f.provider.stop({ sandboxId: row.id });
    const creates = f.creates;
    for (const [i, status] of statuses.entries()) {
      expect(await f.provider.getPrompt({ sandboxId: row.id, promptId: `prompt-${i}` })).toEqual({
        promptId: `prompt-${i}`,
        conversationId: "conversation",
        status,
        done: !["queued", "running"].includes(status),
      });
    }
    await expect(f.provider.getPrompt({ sandboxId: row.id, promptId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.creates).toBe(creates);
    expect((await f.store.get(row.id)).phase).toBe("stopped");
    expect((await f.store.get(row.id)).generation).toBe(1);
    await f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "resume deliberately" });
    expect((await f.store.get(row.id)).generation).toBe(2);
  });
  test("durable event pages cross cursor digit widths in numeric order after compute stops", async () => {
    // Real migrations + PostgreSQL execution own this regression: the old ORDER BY
    // resolves the text output name, not the bigint used by the resume predicate.
    const f = fixture();
    const row = await runningFork(f);
    const maximum = await db.query<{ cursor: string }>(
      "select coalesce(max(cursor),0)::text as cursor from public.modal_events",
    );
    const start = 10 ** String(Number(maximum.rows[0]?.cursor ?? 0) + 130).length - 30;
    await db.query("select setval('public.modal_events_cursor_seq', $1, false)", [start]);
    const events: AgentEvent[] = Array.from({ length: 130 }, (_, i) => ({
      id: `ordered-${i}`,
      // Deliberately not time/UUID ordered: the durable cursor is authoritative.
      at: 130 - i,
      promptId: "ordered-prompt",
      conversationId: i > 1 && i < 129 && i % 7 === 3 ? "other-conversation" : "ordered-conversation",
      ...(i === 0 || i === 1 || i === 129
        ? {
            kind: "prompt" as const,
            text: "task",
            status: i === 0 ? ("queued" as const) : i === 1 ? ("running" as const) : ("finished" as const),
          }
        : { kind: "message" as const, text: `delta-${i}`, partial: i !== 128, tools: [] }),
    }));
    expect(
      await appendModalEvents(
        db,
        scope,
        row.id,
        "1",
        events.map((event, i) => ({
          sequence: i + 1,
          event,
        })),
      ),
    ).toBe(130);
    f.onRpc(async (_row, op) =>
      op === "checkpoint" ? { watermark: 130, acknowledgedSequence: 130, generation: "1" } : undefined,
    );
    await f.provider.stop({ sandboxId: row.id });
    const before = await f.store.get(row.id);
    const calls = [...f.log];
    const creates = f.creates;

    async function read(conversationId?: string, resume?: string) {
      const collected: AgentEvent[] = [];
      let cursor = resume;
      for (let pages = 0; pages < 20; pages++) {
        const page = await f.provider.events({
          sandboxId: row.id,
          limit: 17,
          ...(cursor ? { cursor } : {}),
          ...(conversationId ? { conversationId } : {}),
        });
        if (page.events.length) {
          expect(BigInt(page.cursor ?? "0")).toBeGreaterThan(BigInt(cursor ?? "0"));
          expect(typeof page.cursor).toBe("string");
        }
        collected.push(...page.events);
        cursor = page.cursor;
        if (!page.hasMore) return { collected, cursor };
      }
      throw new Error("Pagination failed to terminate");
    }
    const all = await read();
    expect(all.collected).toEqual(events);
    expect(all.cursor).toBe(String(start + 129));
    expect(await read(undefined, String(start + 16))).toEqual({
      collected: events.slice(17),
      cursor: all.cursor,
    });
    expect((await read("ordered-conversation")).collected).toEqual(
      events.filter((event) => event.conversationId === "ordered-conversation"),
    );
    expect(await read(undefined, all.cursor)).toEqual({ collected: [], cursor: all.cursor });
    expect(await f.provider.getPrompt({ sandboxId: row.id, promptId: "ordered-prompt" })).toEqual({
      promptId: "ordered-prompt",
      conversationId: "ordered-conversation",
      status: "finished",
      done: true,
    });
    expect(f.log).toEqual(calls);
    expect(f.creates).toBe(creates);
    expect(await f.store.get(row.id)).toEqual(before);
  });
  test("a prompt observation delayed across stop never enters activation", async () => {
    const f = fixture();
    const row = await runningFork(f);
    const entered = deferred();
    const release = deferred();
    const get = f.store.get;
    let pause = true;
    f.store.get = async (id) => {
      if (pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return get(id);
    };
    const read = f.provider.getPrompt({ sandboxId: row.id, promptId: "missing" });
    await entered.promise;
    await f.provider.stop({ sandboxId: row.id });
    const creates = f.creates;
    release.resolve();
    await expect(read).rejects.toMatchObject({ code: "not_found" });
    expect(f.creates).toBe(creates);
    expect((await get(row.id)).phase).toBe("stopped");
  });
  test("snapshot deletion leaves already reserved forks usable", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    const fork = await f.provider.fork({ from: name });
    await f.provider.deleteSnapshot(name);
    expect(f.log).not.toContain("delete-image");
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "not_found" });
    expect((await f.provider.get(fork.id)).state).toBe("ready");
    await f.provider.delete({ sandboxId: fork.id });
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(1);
  });
  test("recovery references do not depend on a saved label surviving retirement", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    const saved = await f.store.image(name);
    const child = await f.provider.fork({ from: name });
    await f.provider.stop({ sandboxId: child.id });
    const recovery = (await f.store.get(child.id)).recoveryImageId;
    expect(recovery).toBeDefined();
    await f.provider.deleteSnapshot(name);
    expect(f.log).not.toContain("delete-image");
    // Recovery references are durable independently of an already-retired saved-handle row.
    await f.store.purgeImage(name);
    expect(await f.store.imageReferenced(saved.imageId!)).toBe(true);
    expect(await f.store.imageReferenced(recovery!)).toBe(true);
    await f.provider.exec({ sandboxId: child.id, command: "resume retained recovery" });
    expect((await f.provider.get(child.id)).state).toBe("ready");
  });
  test("retiring one saved handle preserves another live handle sharing its artifact", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const old = crypto.randomUUID(),
      current = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: old });
    const image = await f.store.image(old);
    await f.store.saveImage({ ...image, info: { ...image.info, name: current } });
    await f.provider.deleteSnapshot(old);
    expect(f.log).not.toContain("delete-image");
    expect((await f.provider.getSnapshot(current)).artifactId).toBe(image.imageId);
    await f.provider.deleteSnapshot(current);
    expect(f.log).toContain("delete-image");
  });
  test("snapshot provenance projection never substitutes cached info for missing canonical image or authority", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    const original = await f.store.image(name);
    expect(original.imageId).toBeDefined();
    expect(original.managementAuthority).toBeDefined();
    await db.query("update modal_images set record=record-'imageId'-'managementAuthority' where name=$1", [name]);
    const info = await f.provider.getSnapshot(name);
    expect(info.artifactId).toBeUndefined();
    expect(info.managementAuthority).toBeUndefined();
    expect(info.sourceSandboxId).toBe(builder.id);
  });
  test.each(["current", "retained"])(
    "saved-handle collection protects shared physical recovery references across tenant scopes (%s)",
    async (mode) => {
      const otherOrg = crypto.randomUUID();
      await db.query("insert into orgs(id,name) values($1,$2)", [otherOrg, "shared-ref-" + otherOrg]);
      const otherUser = "00000000-0000-0000-0000-000000000004";
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [otherOrg, otherUser]);
      const other = fixture({ ...scope, orgId: otherOrg, userId: otherUser });
      const seed = await other.provider.createGolden({});
      const seedName = crypto.randomUUID();
      await other.provider.snapshot({ sandboxId: seed.id, name: seedName });
      const child = await other.provider.fork({ from: seedName });
      await other.provider.stop({ sandboxId: child.id });
      const recovery = (await other.store.get(child.id)).recoveryImageId!;
      if (mode === "retained") {
        await other.provider.exec({ sandboxId: child.id, command: "second recovery generation" });
        await other.provider.stop({ sandboxId: child.id });
        await other.provider.exec({ sandboxId: child.id, command: "third recovery generation" });
        const row = await other.store.get(child.id);
        expect(row.retainedRecoveryIds).toContain(recovery);
        expect(row.imageId).not.toBe(recovery);
        expect(row.recoveryImageId).not.toBe(recovery);
        expect(row.sourceImage?.imageId).not.toBe(recovery);
      }
      const f = fixture(),
        builder = await f.provider.createGolden({});
      const source = await f.store.get(builder.id),
        physical = await f.client.sandboxes.fromId(source.physicalId!);
      // SDK snapshots may share immutable physical content without a logical source-image link.
      physical.snapshotFilesystem = async () => ({ imageId: recovery }) as Image;
      const name = crypto.randomUUID();
      await f.provider.snapshot({ sandboxId: builder.id, name });
      const baseline = other.log.length;
      await f.provider.deleteSnapshot(name);
      expect(f.log).not.toContain("delete-image");
      if (mode === "retained") expect((await other.store.get(child.id)).retainedRecoveryIds).toContain(recovery);
      else expect((await other.store.get(child.id)).recoveryImageId).toBe(recovery);
      expect((await other.store.get(child.id)).phase).toBe(mode === "retained" ? "active" : "stopped");
      expect(other.log.length).toBe(baseline);
    },
  );
  test("an unverifiable snapshot backend is not reported as an absent saved handle", async () => {
    const f = fixture(),
      builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    f.client.apps.fromName = async () => {
      throw Object.assign(Error("private SDK diagnostic"), { name: "NotFoundError" });
    };
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(f.provider.deleteSnapshot(name)).rejects.toMatchObject({ code: "provider_not_configured" });
    expect((await f.store.image(name)).info.status).toBe("ready");
    expect(f.log).not.toContain("delete-image");
  });
  test("concurrent lifecycle lease cannot write through the active holder", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    await f.store.lease(row.id, async () => {
      await expect(f.store.lease(row.id, async () => undefined)).rejects.toMatchObject({ code: "conflict" });
    });
  });
  test("HTTP ingest retains message semantics through SQL replay, pagination and conversation filtering", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    const handler = createModalIngestHandler({
      sql: db,
      verifyGrant: async () => ({
        scope,
        claims: { sandboxId: row.id, generation: "1", expiresAt: Date.now() + 60000 },
      }),
    });
    const events = [
      {
        id: "delta",
        at: 1,
        kind: "message" as const,
        conversationId: "a",
        promptId: "p",
        messageId: "native",
        textMode: "delta" as const,
        text: "Hi",
        partial: true,
        tools: [],
      },
      {
        id: "legacy",
        at: 2,
        kind: "message" as const,
        conversationId: "b",
        promptId: "q",
        text: "Historical",
        partial: false,
        tools: [],
      },
      {
        id: "final",
        at: 3,
        kind: "message" as const,
        conversationId: "a",
        promptId: "p",
        messageId: "native",
        textMode: "snapshot" as const,
        text: "Hi there",
        partial: false,
        tools: [],
      },
    ];
    const request = () =>
      new Request("https://example/ingest", {
        method: "POST",
        body: JSON.stringify({
          sandboxId: row.id,
          generation: "1",
          events: events.map((event, i) => ({ sequence: i + 1, event })),
        }),
      });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    const first = await f.provider.events({ sandboxId: row.id, conversationId: "a", limit: 1 });
    expect(first.events).toEqual(events.slice(0, 1));
    expect(first.hasMore).toBe(true);
    expect(
      (await f.provider.events({ sandboxId: row.id, conversationId: "a", cursor: first.cursor ?? "0" })).events,
    ).toEqual(events.slice(2));
    expect((await f.provider.events({ sandboxId: row.id, conversationId: "b" })).events).toEqual(events.slice(1, 2));
  });
  test("native outbox drains large UTF-8 conversations through HTTP ingest and remains readable after stop", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    const grant = {
      token: "fixture-ingest-private-grant",
      sandboxId: row.id,
      generation: "1",
      expiresAt: Date.now() + 60000,
    };
    const handler = createModalIngestHandler({ sql: db, verifyGrant: async () => ({ scope, claims: grant }) });
    const journal = new Journal(":memory:", (s) => s);
    const driver: Driver = {
      start() {
        throw Error("unused");
      },
      async close() {},
    };
    const requests: number[] = [];
    const runner = new Runner(
      journal,
      grant,
      { claude: driver, codex: driver },
      {
        async append(batch) {
          const body = JSON.stringify(batch);
          requests.push(Buffer.byteLength(body));
          const response = await handler(new Request("https://example/ingest", { method: "POST", body }));
          if (!response.ok) throw Error(`ingest_http_${response.status}`);
          return (await response.json()) as { acknowledgedSequence: number };
        },
      },
    );
    const events: AgentEvent[] = ["claude", "codex"].flatMap((harness) => [
      {
        id: `${harness}-running`,
        at: 1,
        kind: "prompt",
        promptId: harness,
        conversationId: harness,
        text: "Inspect output",
        status: "running",
      },
      ...Array.from(
        { length: 5 },
        (_, i): AgentEvent => ({
          id: `${harness}-${i}`,
          at: i + 2,
          kind: "message",
          promptId: harness,
          conversationId: harness,
          messageId: `${harness}-native`,
          textMode: "delta",
          text: "😀".repeat(40000),
          partial: true,
          tools: [
            {
              id: `${harness}-tool-${i}`,
              name: "shell",
              input: { command: "echo ok" },
              result: { output: "ok", isError: false },
            },
          ],
        }),
      ),
      {
        id: `${harness}-completed`,
        at: 8,
        kind: "prompt",
        promptId: harness,
        conversationId: harness,
        text: "Inspect output",
        status: "finished",
      },
    ]);
    try {
      for (const event of events) journal.append(event);
      await runner.flushOutbox();
      expect(journal.ack).toBe(events.length);
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every((bytes) => bytes <= 1048576)).toBe(true);
      await runner.flushOutbox();
      const requestCount = requests.length;
      f.onRpc(async (_row, op) =>
        op === "checkpoint"
          ? { watermark: events.length, acknowledgedSequence: events.length, generation: "1" }
          : undefined,
      );
      await f.provider.stop({ sandboxId: row.id });
      const replay: AgentEvent[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await f.provider.events({ sandboxId: row.id, limit: 3, ...(cursor ? { cursor } : {}) });
        replay.push(...page.events);
        expect(page.cursor).not.toBe(cursor);
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      expect(replay).toEqual(events);
      const tail = await f.provider.events({ sandboxId: row.id, ...(cursor ? { cursor } : {}) });
      expect(tail.events).toEqual([]);
      expect(tail.cursor).toBe(cursor);
      expect(tail.hasMore).toBe(false);
      expect(requests).toHaveLength(requestCount);
    } finally {
      journal.close();
    }
  });
  test("events dedupe, acknowledge only contiguous commit and fence old generation", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    const event = { id: "event", at: 1, kind: "other" as const, type: "test", data: {} };
    expect(await appendModalEvents(db, scope, row.id, "1", [{ sequence: 2, event }])).toBe(0);
    expect(
      await appendModalEvents(db, scope, row.id, "1", [
        { sequence: 1, event },
        { sequence: 2, event },
      ]),
    ).toBe(2);
    expect((await f.provider.events({ sandboxId: row.id })).events).toHaveLength(2);
    await expect(appendModalEvents(db, scope, row.id, "0", [{ sequence: 3, event }])).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  test("restored producer sequences continue checkpoint watermark instead of waiting for sequence one", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    await f.store.lease(row.id, async (current, save) => {
      current.generation = 2;
      current.eventBase = 42;
      await save(current);
    });
    const event = { id: "restored", at: 1, kind: "other" as const, type: "test", data: {} };
    expect(await appendModalEvents(db, scope, row.id, "2", [{ sequence: 43, event }])).toBe(43);
    expect(await f.store.watermark(row.id, 2)).toBe(43);
    expect((await f.provider.events({ sandboxId: row.id })).events).toHaveLength(1);
  });
  test("actual composition forks ORG snapshot into owner-private access while management authority stays ORG and GC counts private references", async () => {
    const orgScope: Scope = { ...scope, visibility: "org" };
    const f = fixture(orgScope);
    const builder = await f.provider.createGolden({});
    const snapshot = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: snapshot });
    const authorities: ModalManagementAuthority[] = [];
    let preparedFromComposition = false;
    const configuration: ComposedModalOptions = {
      beforePrompt: async (provider, id) => {
        await provider.get(id);
        await provider.configureMcp({
          sandboxId: id,
          configuration: { revision: "composed-before-turn", servers: {} },
        });
        preparedFromComposition = true;
      },
      ...compositionOptions(f, scope, orgScope),
      resolveManagementCredentials: async (authority) => {
        authorities.push(authority);
        return {
          tokenId: "synthetic-org-management",
          tokenSecret: "synthetic-org-management-secret",
          credentialScope: "org",
          credentialOwnerId: scope.orgId,
        };
      },
      client: f.client,
      resolveHarnessEnvironment: async (machine) => {
        expect(machine.launchUserId).toBe(scope.userId);
        return {
          claudeEnv: { EXPLICIT_MODEL_ENV: "synthetic-model" },
          codexEnv: {},
          mcp: {
            revision: "owner-private-revision",
            servers: {
              personal: {
                type: "http",
                url: "https://personal-mcp.example/mcp",
                headers: { Authorization: "synthetic-personal-mcp" },
              },
            },
          },
        };
      },
    };
    const { provider, close } = await createComposedModalProvider(configuration);
    const launched = await provider.fork({ from: snapshot, name: "private-personal-MCP" });
    const privateStore = createSqlModalStore(db, scope);
    const machine = await privateStore.get(launched.id);
    expect(machine.sourceImage).toMatchObject({ name: snapshot });
    expect(machine.processBaseline).toMatchObject({ physicalId: machine.physicalId, generation: machine.generation });
    expect(machine.launchUserId).toBe(scope.userId);
    expect(
      await provider.configureMcp({
        sandboxId: launched.id,
        configuration: { revision: "post-init-authority", servers: {} },
      }),
    ).toEqual({ revision: "post-init-authority" });
    const receipt = await provider.prompt({
      sandboxId: launched.id,
      harness: "claude",
      text: "composed lifecycle hook",
    });
    expect(receipt.status).toBe("queued");
    expect(preparedFromComposition).toBe(true);
    expect((await provider.list()).items.map((x) => x.id)).toContain(launched.id);
    await expect(f.store.get(launched.id)).rejects.toMatchObject({ code: "not_found" });
    const otherScope = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const other = await createComposedModalProvider({
      ...configuration,
      scope: otherScope,
      sourceScope: { ...orgScope, userId: otherScope.userId },
    });
    await expect(other.provider.get(launched.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(other.provider.events({ sandboxId: launched.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(
      other.provider.configureMcp({ sandboxId: launched.id, configuration: { revision: "not-owner", servers: {} } }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      other.provider.prepareNativeHarnessCwd({
        sandboxId: launched.id,
        harness: "claude",
        cwd: "/home/user/repos/private",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await other.provider.list()).items.some((x) => x.id === launched.id)).toBe(false);
    other.close();
    await expect(createSqlModalStore(db, otherScope).get(launched.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await createSqlModalStore(db, otherScope).list()).some((x) => x.info.id === launched.id)).toBe(false);
    await expect(createSqlModalStore(db, scope).image(snapshot)).rejects.toMatchObject({ code: "not_found" });
    const { resolveManagementCredentials: _resolveSource, ...operatorWithSource } = configuration;
    const wrongSource = await createComposedModalProvider({ ...operatorWithSource, sourceScope: scope });
    await expect(wrongSource.provider.get(launched.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(wrongSource.provider.delete({ sandboxId: launched.id })).rejects.toMatchObject({ code: "forbidden" });
    expect((await privateStore.get(launched.id)).phase).toBe("active");
    wrongSource.close();
    expect((await provider.getSnapshot(snapshot)).status).toBe("ready");
    expect(authorities).toHaveLength(2);
    for (const authority of authorities)
      expect(authority).toEqual({
        orgId: scope.orgId,
        sourceGoldenVisibility: "org",
        credentialScope: "org",
        credentialOwnerId: scope.orgId,
        binding: scope.binding,
      });
    expect(JSON.stringify(f.bootstraps.get(machine.physicalId ?? ""))).not.toContain("synthetic-org-management");
    expect(f.bootstraps.get(machine.physicalId ?? "")).toMatchObject({
      mcp: {
        revision: "owner-private-revision",
        servers: { personal: { type: "http", headers: { Authorization: "synthetic-personal-mcp" } } },
      },
    });
    await f.provider.deleteSnapshot(snapshot);
    expect(f.log).not.toContain("delete-image");
    await provider.delete({ sandboxId: launched.id });
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(1);
    close();
    const { resolveManagementCredentials: _resolver, ...operatorConfiguration } = configuration;
    const operator = await createComposedModalProvider(operatorConfiguration);
    await expect(operator.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    operator.close();
    const { client: _client, ...withoutClient } = operatorConfiguration;
    await expect(createComposedModalProvider(withoutClient)).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(
      createComposedModalProvider({ ...operatorConfiguration, tokenId: "incomplete-pair" }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(
      createComposedModalProvider({
        ...configuration,
        resolveManagementCredentials: async () => ({
          tokenId: "private-must-not-win",
          tokenSecret: "private-must-not-win-secret",
          credentialScope: "user",
          credentialOwnerId: scope.userId,
        }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createComposedModalProvider({ ...configuration, sourceScope: { ...scope, userId: otherScope.userId } }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("private golden with explicit org fallback authority stays owner-private across fork/restore and rejects scope/key substitution", async () => {
    const f = fixture();
    const requested = { credentialScope: "org" as const, credentialOwnerId: scope.orgId };
    const seen: ModalManagementAuthority[] = [];
    const configuration: ComposedModalOptions = {
      ...compositionOptions(f),
      managementAuthority: requested,
      resolveManagementCredentials: async (authority) => {
        seen.push(authority);
        return {
          tokenId: "synthetic-fallback-id",
          tokenSecret: "synthetic-fallback-secret",
          credentialScope: "org",
          credentialOwnerId: scope.orgId,
        };
      },
    };
    const { provider, close } = await createComposedModalProvider(configuration);
    const builder = await provider.createGolden({});
    const snapshot = crypto.randomUUID();
    await provider.snapshot({ sandboxId: builder.id, name: snapshot });
    expect((await f.store.get(builder.id)).managementAuthority).toEqual(requested);
    expect((await f.store.image(snapshot)).managementAuthority).toEqual(requested);
    const { provider: restoredConnection } = await createComposedModalProvider(configuration); // New server adapter retains chosen immutable context.
    const fork = await restoredConnection.fork({ from: snapshot });
    expect((await f.store.get(fork.id)).managementAuthority).toEqual(requested);
    await restoredConnection.stop({ sandboxId: fork.id });
    await restoredConnection.configureMcp({
      sandboxId: fork.id,
      configuration: { revision: "after-restore", servers: {} },
    });
    expect((await f.store.get(fork.id)).generation).toBe(2);
    expect((await f.store.get(fork.id)).managementAuthority).toEqual(requested);
    for (const authority of seen)
      expect(authority).toMatchObject({
        sourceGoldenVisibility: "private",
        credentialScope: "org",
        credentialOwnerId: scope.orgId,
      });
    const otherScope = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const other = await createComposedModalProvider({ ...configuration, scope: otherScope, sourceScope: otherScope });
    await expect(other.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    await expect(other.provider.get(fork.id)).rejects.toMatchObject({ code: "not_found" });
    const orgView = await createComposedModalProvider({
      ...configuration,
      scope: { ...scope, visibility: "org" },
      sourceScope: { ...scope, visibility: "org" },
    });
    await expect(orgView.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    const userKey = await createComposedModalProvider({
      ...compositionOptions(f),
      managementAuthority: { credentialScope: "user", credentialOwnerId: scope.userId },
    });
    await expect(userKey.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.fork({ from: snapshot })).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.get(fork.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.delete({ sandboxId: fork.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createComposedModalProvider({
        ...configuration,
        resolveManagementCredentials: async () => ({
          tokenId: "wrong-user-id",
          tokenSecret: "wrong-user-secret",
          credentialScope: "user",
          credentialOwnerId: scope.userId,
        }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createComposedModalProvider({
        ...configuration,
        scope: { ...scope, visibility: "org" },
        sourceScope: { ...scope, visibility: "org" },
        managementAuthority: { credentialScope: "user", credentialOwnerId: scope.userId },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createComposedModalProvider({
        ...configuration,
        managementAuthority: { credentialScope: "org", credentialOwnerId: otherScope.userId },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(JSON.stringify((await db.query("select record from public.modal_machines")).rows)).not.toContain(
      "synthetic-fallback-secret",
    );
    const calls = f.log.filter((x) => x === "delete-image").length;
    await provider.deleteSnapshot(snapshot);
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(calls);
    await userKey.provider.collectGarbage();
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(calls); // Cannot collect another authority's tombstone.
    await restoredConnection.delete({ sandboxId: fork.id });
    expect(f.log.filter((x) => x === "delete-image").length).toBeGreaterThan(calls);
    close();
  });
  test("actual bootstrap separates GitHub exec credentials from model env, disables them explicitly, and re-resolves on restore without persisting values", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    let enabled = true,
      calls = 0;
    const options: ComposedModalOptions = {
      ...compositionOptions(f),
      resolveHarnessEnvironment: async (_machine, launchEnv) => {
        calls++;
        return {
          claudeEnv: { ANTHROPIC_API_KEY: "synthetic-model-private" },
          codexEnv: { OPENAI_API_KEY: "synthetic-codex-private" },
          ...(enabled && !Object.keys(launchEnv).length
            ? { execEnv: { GH_TOKEN: "synthetic-refreshed-github", GITHUB_TOKEN: "synthetic-refreshed-github" } }
            : enabled
              ? {}
              : { execEnv: {} }),
        };
      },
    };
    const { provider } = await createComposedModalProvider(options);
    const fork = await provider.fork({
      from: name,
      env: {
        GH_TOKEN: "synthetic-initial-github",
        GITHUB_TOKEN: "synthetic-initial-github",
        ANTHROPIC_API_KEY: "must-not-reach-exec",
        MODAL_TOKEN_SECRET: "must-not-reach-exec",
      },
    });
    let row = await f.store.get(fork.id);
    let bootstrap = f.bootstraps.get(row.physicalId ?? "");
    expect(bootstrap).toMatchObject({
      credentialFreeBuilder: false,
      claudeEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      codexEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      execEnv: {
        GH_TOKEN: "synthetic-initial-github",
        GITHUB_TOKEN: "synthetic-initial-github",
        HOME: "/home/user",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    expect((bootstrap as unknown as { execEnv: object }).execEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect((bootstrap as unknown as { execEnv: object }).execEnv).not.toHaveProperty("MODAL_TOKEN_SECRET");
    await provider.stop({ sandboxId: fork.id });
    await provider.exec({ sandboxId: fork.id, command: "git status" });
    row = await f.store.get(fork.id);
    bootstrap = f.bootstraps.get(row.physicalId ?? "");
    expect(bootstrap).toMatchObject({
      execEnv: { GH_TOKEN: "synthetic-refreshed-github", GITHUB_TOKEN: "synthetic-refreshed-github" },
    });
    expect(calls).toBe(2);
    expect(JSON.stringify((await db.query("select record from public.modal_machines")).rows)).not.toContain(
      "synthetic-initial-github",
    );
    expect(JSON.stringify(row)).not.toContain("synthetic-refreshed-github");
    enabled = false;
    const disabled = await provider.fork({ from: name, env: { GH_TOKEN: "must-stay-disabled" } });
    const disabledRow = await f.store.get(disabled.id);
    expect(
      (f.bootstraps.get(disabledRow.physicalId ?? "") as unknown as { execEnv: object }).execEnv,
    ).not.toHaveProperty("GH_TOKEN");
  });
  test("NULL canonical golden master restores from its exact owned image, reconnect is idempotent, and resnapshot/fork remain credential-free", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const first = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: first });
    await f.provider.delete({ sandboxId: builder.id });
    await expect(
      f.provider.exec({ sandboxId: builder.id, command: "must not implicitly unseal" }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    const restored = await f.provider.restoreGoldenMaster({ snapshotId: first });
    expect(restored.id).toBe(builder.id);
    expect(restored.physicalGeneration).toBe("2");
    expect((await f.store.get(builder.id)).golden).toBe(true);
    await f.provider.exec({ sandboxId: builder.id, command: "edit .env without model sessions" });
    const before = f.creates;
    expect((await f.provider.restoreGoldenMaster({ snapshotId: first, sandboxId: builder.id })).id).toBe(builder.id);
    expect(f.creates).toBe(before);
    const second = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: second });
    await f.provider.delete({ sandboxId: builder.id });
    const next = await f.provider.restoreGoldenMaster({ snapshotId: second });
    expect(next.id).toBe(builder.id);
    expect(next.physicalGeneration).toBe("3");
    const fork = await f.provider.fork({ from: second });
    expect(fork.id).not.toBe(builder.id);
    expect((await f.store.get(fork.id)).golden).toBe(false);
    const unrelated = await f.provider.createGolden({});
    const count = f.creates;
    await expect(f.provider.restoreGoldenMaster({ sandboxId: unrelated.id, snapshotId: second })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(f.creates).toBe(count);
  });
  test("golden restore retries unknown create by deterministic identity and never discards an uncertain checkpoint", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    await f.provider.delete({ sandboxId: builder.id });
    f.failCreate(true);
    await expect(f.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({ code: "unknown" });
    const count = f.creates;
    expect((await f.store.get(builder.id)).phase).toBe("creating");
    f.failCreate(false);
    const restored = await f.provider.restoreGoldenMaster({ snapshotId: name });
    expect(restored.physicalGeneration).toBe("2");
    expect(f.creates).toBe(count);
    await f.store.lease(builder.id, async (row, save) => {
      row.phase = "snapshot";
      row.quiesced = true;
      await save(row);
    });
    await expect(f.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({ code: "conflict" });
    expect(f.creates).toBe(count);
  });
  test("fresh history purge is committed before bootstrap, not repeated on unknown boot retry, and skipped for working recovery", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    const key = crypto.randomUUID();
    f.failBoot(true);
    await expect(f.provider.fork({ from: name, idempotencyKey: key })).rejects.toMatchObject({ code: "unknown" });
    const before = f.log.filter((x) => x.startsWith("fresh-")).length;
    f.failBoot(false);
    const fork = await f.provider.fork({ from: name, idempotencyKey: key });
    expect(f.log.filter((x) => x.startsWith("fresh-"))).toHaveLength(before);
    expect((await f.store.get(fork.id)).freshStatePreparedGeneration).toBe(1);
    await f.provider.stop({ sandboxId: fork.id });
    await f.provider.exec({ sandboxId: fork.id, command: "resume session" });
    expect((await f.store.get(fork.id)).generation).toBe(2);
    expect(f.log.filter((x) => x.startsWith("fresh-"))).toHaveLength(before);
  });
  test("golden restore recovers a lost final active commit without replacing its runner or losing edits", async () => {
    let fail = false;
    const sql: Sql = {
      async query<T>(statement: string, params?: unknown[]) {
        const candidate = params?.[3];
        if (
          fail &&
          typeof candidate === "string" &&
          candidate.startsWith("{") &&
          JSON.parse(candidate).phase === "active" &&
          JSON.parse(candidate).goldenRestore
        ) {
          fail = false;
          throw Error("lost active commit");
        }
        return db.query<T>(statement, params);
      },
    };
    const f = fixture(scope, sql);
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    await f.provider.delete({ sandboxId: builder.id });
    fail = true;
    await expect(f.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({ code: "unknown" });
    expect((await f.store.get(builder.id)).phase).toBe("booting");
    const count = f.creates,
      starts = f.log.filter((x) => x === "start-2").length;
    const restored = await f.provider.restoreGoldenMaster({ snapshotId: name });
    expect(restored.physicalGeneration).toBe("2");
    expect(f.creates).toBe(count);
    expect(f.log.filter((x) => x === "start-2")).toHaveLength(starts);
  });
  test("actual source-scoped golden restore keeps org-fallback provenance and boots without model/session credentials", async () => {
    const f = fixture();
    let harnessResolutions = 0;
    const connection = await createComposedModalProvider({
      ...compositionOptions(f),
      managementAuthority: { credentialScope: "org", credentialOwnerId: scope.orgId },
      resolveHarnessEnvironment: async () => {
        harnessResolutions++;
        return { claudeEnv: { ANTHROPIC_API_KEY: "synthetic-model-only" }, codexEnv: {} };
      },
    });
    const builder = await connection.provider.createGolden({});
    const name = crypto.randomUUID();
    await connection.provider.snapshot({ sandboxId: builder.id, name });
    await connection.provider.delete({ sandboxId: builder.id });
    const restored = await connection.provider.restoreGoldenMaster({ snapshotId: name });
    const row = await f.store.get(restored.id);
    expect(restored.id).toBe(builder.id);
    expect(restored.physicalGeneration).toBe("2");
    expect(harnessResolutions).toBe(0);
    expect(row.managementAuthority).toEqual({ credentialScope: "org", credentialOwnerId: scope.orgId });
    expect(row.processBaseline).toMatchObject({ physicalId: row.physicalId, generation: 2 });
    expect(f.bootstraps.get(row.physicalId ?? "")).toMatchObject({
      credentialFreeBuilder: true,
      claudeEnv: {},
      codexEnv: {},
      grant: { generation: "2" },
    });
    expect(JSON.stringify(f.bootstraps.get(row.physicalId ?? ""))).not.toContain("synthetic-model-only");
    const other = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const outsider = await createComposedModalProvider({
      ...compositionOptions(f, other),
      managementAuthority: { credentialScope: "org", credentialOwnerId: scope.orgId },
    });
    await expect(outsider.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({
      code: "not_found",
    });
    connection.close();
    outsider.close();
  });
  test("golden builders reject prompts before runner/model admission and physical generation never trusts labels", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({ labels: { physicalGeneration: "untrusted-label" } });
    const before = f.log.length;
    await expect(
      f.provider.prompt({ sandboxId: builder.id, harness: "claude", text: "must never start" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      f.provider.steer({ sandboxId: builder.id, conversationId: "legacy-builder-turn", text: "must not restart" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.log).toHaveLength(before);
    expect(f.log).not.toContain("prompt");
    expect(builder.physicalGeneration).toBe("1");
    expect((await f.provider.get(builder.id)).physicalGeneration).toBe("1");
    const fork = await runningFork(f);
    expect(fork.physicalGeneration).toBe("1");
    await f.provider.stop({ sandboxId: fork.id });
    await f.provider.exec({ sandboxId: fork.id, command: "true" });
    expect((await f.provider.get(fork.id)).physicalGeneration).toBe("2");
  });
  test("golden history cleanup and filesystem save never run before the exact durable event ACK", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    f.onRpc(async (row, op) =>
      op === "checkpoint" ? { generation: String(row.generation), watermark: 1, acknowledgedSequence: 1 } : undefined,
    );
    await expect(f.provider.snapshot({ sandboxId: builder.id, name: crypto.randomUUID() })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.log).not.toContain("scrub");
    expect(f.log).not.toContain("snapshot");
    expect(f.log).not.toContain("terminate");
  });
  test("failed fork boot exports exact reservation/physical/image provenance for scoped disposable cleanup", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    const sourceImage = (await f.store.image(name)).imageId;
    f.failBoot(true);
    let receipt: ReturnType<typeof modalFailureReceipt>;
    try {
      await f.provider.fork({ from: name });
      throw Error("boot unexpectedly succeeded");
    } catch (error) {
      receipt = modalFailureReceipt(error);
    }
    if (!receipt) throw Error("missing failed reservation receipt");
    expect(receipt.phase).toBe("booting");
    expect(receipt.physicalId).toBeDefined();
    expect(receipt.imageId).toBe(sourceImage);
    expect(receipt.sourceImage).toMatchObject({ name, imageId: sourceImage });
    expect((await f.store.get(receipt.sandboxId)).phase).toBe("booting");
    const exported = JSON.parse(JSON.stringify(await f.provider.resourceReceipts()));
    expect(exported).toContainEqual(
      expect.objectContaining({ sandboxId: builder.id, snapshotImages: [{ name, imageId: sourceImage }] }),
    );
    expect(JSON.stringify(receipt)).not.toContain("synthetic-secret");
    expect(JSON.stringify(receipt)).not.toContain("headers");
    await f.provider.delete({ sandboxId: receipt.sandboxId });
    expect((await f.store.get(receipt.sandboxId)).phase).toBe("deleted");
    expect(f.log).toContain("terminate");
  });
  test("known completed Image survives a failed SQL commit in the failure receipt without terminating source", async () => {
    let fail = false;
    const sql: Sql = {
      async query<T>(statement: string, params?: unknown[]) {
        const candidate = params?.[3];
        if (
          fail &&
          typeof candidate === "string" &&
          candidate.startsWith("{") &&
          JSON.parse(candidate).snapshotImages?.length
        ) {
          fail = false;
          throw Error("synthetic image reference commit failure");
        }
        return db.query<T>(statement, params);
      },
    };
    const f = fixture(scope, sql);
    const builder = await f.provider.createGolden({});
    const name = crypto.randomUUID();
    fail = true;
    let receipt: ReturnType<typeof modalFailureReceipt>;
    try {
      await f.provider.snapshot({ sandboxId: builder.id, name });
      throw Error("snapshot unexpectedly succeeded");
    } catch (error) {
      receipt = modalFailureReceipt(error);
    }
    if (!receipt) throw Error("missing image provenance receipt");
    expect(receipt.snapshotImages).toHaveLength(1);
    expect(receipt.snapshotImages[0]?.name).toBe(name);
    expect(receipt.snapshotImages[0]?.imageId).toStartWith("im_");
    expect(receipt.phase).toBe("snapshot");
    expect(f.log).not.toContain("terminate");
    const persisted = await f.provider.resourceReceipts();
    const merged = mergeModalResourceReceipts([receipt, ...persisted]);
    expect(merged.find((x) => x.sandboxId === builder.id)?.snapshotImages).toEqual(receipt.snapshotImages);
  });
  test("beforePrompt sees ready first/restored generation outside the lease, configures before native submission, and supports parallel stable turns", async () => {
    const observed: string[] = [];
    const f = fixture(scope, db, async (provider, id) => {
      const info = await provider.get(id);
      expect(info.state).toBe("ready");
      observed.push(info.physicalGeneration ?? "missing");
      await provider.configureMcp({
        sandboxId: id,
        configuration: { revision: `generation-${info.physicalGeneration}`, servers: {} },
      });
    });
    const row = await runningFork(f);
    await Promise.all(
      (["claude", "codex"] as const).map((harness) =>
        f.provider.prompt({ sandboxId: row.id, harness, text: "prepared turn" }),
      ),
    );
    expect(observed).toEqual(["1", "1"]);
    expect(f.log.indexOf("configureMcp")).toBeLessThan(f.log.indexOf("prompt"));
    await f.provider.stop({ sandboxId: row.id });
    await f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "restore before hook" });
    expect(observed.at(-1)).toBe("2");
  });
  test("beforePrompt failure or an intervening checkpoint/restore refuses submission; goldens never call the hook", async () => {
    let fail = true,
      calls = 0;
    const f = fixture(scope, db, async (provider, id) => {
      calls++;
      if (fail) throw Error("private registry failure must not leak");
      await provider.stop({ sandboxId: id });
      await provider.exec({ sandboxId: id, command: "restore" });
    });
    const row = await runningFork(f);
    await expect(
      f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "must not start" }),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(f.log).not.toContain("prompt");
    fail = false;
    await expect(
      f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "stale prepared generation" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.store.get(row.id)).generation).toBe(2);
    expect(f.log).not.toContain("prompt");
    const builder = await f.provider.createGolden({});
    const before = calls;
    await expect(
      f.provider.prompt({ sandboxId: builder.id, harness: "claude", text: "no hook on builder" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(before);
  });
  test("beforePrompt fence is rechecked after healthyAdmission mutates the runner incarnation", async () => {
    let prepared = false;
    const f = fixture(scope, db, async () => {
      prepared = true;
    });
    const row = await runningFork(f);
    f.onRpc(async (current, op) => {
      if (prepared && op === "health") {
        current.generation++;
        return { generation: String(current.generation), ready: true };
      }
    });
    await expect(
      f.provider.prompt({ sandboxId: row.id, harness: "codex", text: "must not submit after replacement" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.log).not.toContain("prompt");
  });
  test("golden exec alone takes scoped leased SDK root control, worker exec stays journaled runner, and unsupported/closed requests refuse", async () => {
    const f = fixture();
    const builder = await f.provider.createGolden({});
    await f.provider.exec({ sandboxId: builder.id, command: "root scanner", timeoutSeconds: 600 });
    expect(f.log).toContain("root-exec");
    expect(f.log).not.toContain("exec");
    const count = f.log.filter((x) => x === "root-exec").length;
    await expect(
      f.provider.exec({ sandboxId: builder.id, command: "unsupported", detached: true }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      f.provider.exec({ sandboxId: builder.id, command: "timeout", timeoutSeconds: 601 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.provider.exec({ sandboxId: builder.id, command: "badcwd", cwd: "relative" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.log.filter((x) => x === "root-exec")).toHaveLength(count);
    await f.store.lease(builder.id, async () => {
      await expect(f.provider.exec({ sandboxId: builder.id, command: "busy" })).rejects.toMatchObject({
        providerCode: "lifecycle_lease_busy",
      });
    });
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name });
    await expect(f.provider.exec({ sandboxId: builder.id, command: "must not unseal" })).rejects.toMatchObject({
      code: "sandbox_not_ready",
    });
    const worker = await f.provider.fork({ from: name });
    await f.provider.exec({ sandboxId: worker.id, command: "worker exec" });
    expect(f.log).toContain("exec");
    expect(f.log.filter((x) => x === "root-exec")).toHaveLength(count);
  });
  test("native harness cwd is durable per harness and forwarded privately on prompt/resume without changing text, exec or steer", async () => {
    const f = fixture();
    const row = await runningFork(f);
    const claudeCwd = "/home/user/repos/repo with spaces;$(not-a-command)",
      codexCwd = "/home/user/repos/backend";
    const originalCreates = f.creates;
    await f.provider.prepareNativeHarnessCwd({ sandboxId: row.id, harness: "claude", cwd: claudeCwd });
    await f.provider.prepareNativeHarnessCwd({ sandboxId: row.id, harness: "codex", cwd: codexCwd });
    expect((await f.store.get(row.id)).harnessCwds).toEqual({ claude: claudeCwd, codex: codexCwd });
    expect(f.creates).toBe(originalCreates);
    expect(f.log).not.toContain("exec");
    const sent: { op: string; input: unknown; generation: number }[] = [];
    f.onRpc(async (current, op, input) => {
      if (op === "prompt" || op === "steer") sent.push({ op, input, generation: current.generation });
    });
    await f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "unmodified task" });
    await f.provider.prompt({
      sandboxId: row.id,
      harness: "codex",
      text: "resume task",
      conversationId: "existing-conversation",
    });
    expect(sent[0]).toMatchObject({
      op: "prompt",
      input: { input: { cwd: claudeCwd, text: "unmodified task", harness: "claude" } },
      generation: 1,
    });
    expect(sent[1]).toMatchObject({
      op: "prompt",
      input: { input: { cwd: codexCwd, text: "resume task", conversationId: "existing-conversation" } },
      generation: 1,
    });
    await f.provider.stop({ sandboxId: row.id });
    await f.provider.prompt({
      sandboxId: row.id,
      harness: "claude",
      text: "restored task",
      conversationId: "existing-claude",
    });
    expect(sent[2]).toMatchObject({
      op: "prompt",
      input: { input: { cwd: claudeCwd, conversationId: "existing-claude" } },
      generation: 2,
    });
    expect((await f.store.get(row.id)).harnessCwds).toEqual({ claude: claudeCwd, codex: codexCwd });
    await f.provider.prepareNativeHarnessCwd({
      sandboxId: row.id,
      harness: "claude",
      cwd: "/home/user/repos/next-conversation",
    });
    await f.provider.steer({ sandboxId: row.id, conversationId: "existing-claude", text: "continue in original cwd" });
    expect(sent[3]).toEqual({
      op: "steer",
      generation: 2,
      input: { sandboxId: row.id, conversationId: "existing-claude", text: "continue in original cwd" },
    });
  });
  test("native cwd preparation validates path data and owner/admission while unprepared prompts use runtime defaults", async () => {
    const f = fixture();
    const row = await runningFork(f);
    for (const cwd of [
      "relative/repo",
      "/home/user/../repo",
      "/home/user//repo",
      "/home/user/repo\n",
      "/home/user/repo\0",
      `/${"x".repeat(4096)}`,
    ])
      await expect(
        f.provider.prepareNativeHarnessCwd({ sandboxId: row.id, harness: "claude", cwd }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await f.store.get(row.id)).harnessCwds).toBeUndefined();
    const other = createSqlModalStore(db, { ...scope, userId: "00000000-0000-0000-0000-000000000004" });
    await expect(other.get(row.id)).rejects.toMatchObject({ code: "not_found" });
    f.onRpc(async (_row, op, input) => {
      if (op === "prompt")
        expect(input).toMatchObject({ input: { sandboxId: row.id, harness: "codex", text: "default cwd" } });
      if (op === "prompt") expect((input as { input: object }).input).not.toHaveProperty("cwd");
    });
    // Only prepared durable state may set the private additive field; never trust an injected caller field.
    await f.provider.prompt({
      ...{ sandboxId: row.id, harness: "codex" as const, text: "default cwd", cwd: "/unprepared" },
    });
    await f.store.lease(row.id, async (current, save) => {
      current.phase = "checkpoint";
      current.info.state = "stopping";
      await save(current);
    });
    await expect(
      f.provider.prepareNativeHarnessCwd({ sandboxId: row.id, harness: "claude", cwd: "/home/user/repos/valid" }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    const builder = await f.provider.createGolden({});
    await f.provider.snapshot({ sandboxId: builder.id, name: crypto.randomUUID() });
    await expect(
      f.provider.prepareNativeHarnessCwd({ sandboxId: builder.id, harness: "claude", cwd: "/home/user/repos/valid" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  test("configureMcp serializes transient authority with turn admission, returns only revision and never persists config", async () => {
    const f = fixture();
    const row = await runningFork(f);
    const entered = deferred(),
      release = deferred();
    const configuration = {
      revision: "authoritative-private-revision",
      servers: {
        private: {
          type: "http" as const,
          url: "https://private.example/mcp",
          headers: { Authorization: "synthetic-private-auth" },
        },
      },
    };
    f.onRpc(async (_row, op, input) => {
      if (op !== "configureMcp") return;
      expect(input).toEqual({ configuration });
      entered.resolve();
      await release.promise;
      return { revision: configuration.revision, servers: configuration.servers, unsafeAuth: "must-not-echo" };
    });
    const configuring = f.provider.configureMcp({ sandboxId: row.id, configuration });
    await entered.promise;
    const prompts = Promise.all(
      (["claude", "codex"] as const).map((harness) =>
        f.provider.prompt({ sandboxId: row.id, harness, text: "queued behind authoritative config" }),
      ),
    );
    await expect(f.provider.stop({ sandboxId: row.id })).rejects.toMatchObject({ code: "conflict" });
    expect(f.log.at(-1)).toBe("configureMcp");
    release.resolve();
    expect(await configuring).toEqual({ revision: configuration.revision });
    const receipts = await prompts;
    expect(new Set(receipts.map((x) => x.promptId)).size).toBe(2);
    expect(f.log.indexOf("configureMcp")).toBeLessThan(f.log.indexOf("prompt"));
    const stored = JSON.stringify((await db.query("select record from public.modal_machines")).rows);
    expect(stored).not.toContain(configuration.revision);
    expect(stored).not.toContain("synthetic-private-auth");
    expect(stored).not.toContain("private.example");
  });
  test("configureMcp resumes under the new generation lease, supports empty servers, rejects bad receipts and sealed goldens", async () => {
    const f = fixture();
    const row = await runningFork(f);
    await f.provider.stop({ sandboxId: row.id });
    const empty = { revision: "remove-connections", servers: {} };
    f.onRpc(async (current, op, input) => {
      if (op !== "configureMcp") return;
      expect(current.phase).toBe("active");
      expect(current.generation).toBe(2);
      expect(input).toEqual({ configuration: empty });
      await expect(f.store.lease(row.id, async () => {})).rejects.toMatchObject({
        providerCode: "lifecycle_lease_busy",
      });
      return { revision: empty.revision };
    });
    expect(await f.provider.configureMcp({ sandboxId: row.id, configuration: empty })).toEqual({
      revision: empty.revision,
    });
    f.onRpc(async (_row, op) => (op === "configureMcp" ? { revision: "wrong" } : undefined));
    await expect(f.provider.configureMcp({ sandboxId: row.id, configuration: empty })).rejects.toMatchObject({
      code: "unavailable",
    });
    const builder = await f.provider.createGolden({});
    await f.provider.snapshot({ sandboxId: builder.id, name: crypto.randomUUID() });
    await f.provider.stop({ sandboxId: builder.id });
    const before = await f.store.get(builder.id);
    const calls = f.log.filter((x) => x === "configureMcp").length;
    await expect(f.provider.configureMcp({ sandboxId: builder.id, configuration: empty })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await f.store.get(builder.id)).generation).toBe(before.generation);
    expect((await f.store.get(builder.id)).phase).toBe("stopped");
    expect(f.log.filter((x) => x === "configureMcp")).toHaveLength(calls);
  });
  test("configure and new turns refuse a live physical runner whose admission or generation is sealed", async () => {
    const f = fixture();
    const row = await runningFork(f);
    f.onRpc(async (current, op) =>
      op === "health" ? { generation: String(current.generation), ready: false } : undefined,
    );
    await expect(
      f.provider.configureMcp({ sandboxId: row.id, configuration: { revision: "cannot-unseal", servers: {} } }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    await expect(
      f.provider.prompt({ sandboxId: row.id, harness: "claude", text: "not admitted" }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    f.onRpc(async (_row, op) => (op === "health" ? { generation: "foreign-generation", ready: true } : undefined));
    await expect(
      f.provider.configureMcp({ sandboxId: row.id, configuration: { revision: "wrong-generation", servers: {} } }),
    ).rejects.toMatchObject({ code: "sandbox_not_ready" });
    expect(f.log).not.toContain("configureMcp");
    expect(f.log).not.toContain("prompt");
  });
  test("configureMcp wire preserves protocol identity/current grant and maps safe errors without auth output", async () => {
    const f = fixture();
    const info = await runningFork(f);
    const row = await f.store.get(info.id);
    const configuration = {
      revision: "wire-revision",
      servers: {
        private: {
          type: "http" as const,
          url: "https://mcp.example",
          headers: { Authorization: "synthetic-wire-auth" },
        },
      },
    };
    let mode = "success",
      calls = 0;
    const fetcher = (async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ version: 1, sandboxId: info.id, op: "configureMcp", configuration });
      expect(typeof request.requestId).toBe("string");
      expect(new Headers(init?.headers).get("x-armada-runner-grant")).toBe("current-generation-grant");
      if (mode === "conflict")
        return Response.json({ version: 1, requestId: request.requestId, error: "conflict" }, { status: 409 });
      if (mode === "foreign-error")
        return Response.json({ version: 1, requestId: "foreign", error: "conflict" }, { status: 409 });
      return Response.json({
        version: mode === "wrong-version" ? 2 : 1,
        requestId: request.requestId,
        result: { revision: configuration.revision },
      });
    }) as typeof fetch;
    const access = async () => ({
      url: "https://runner.example",
      connectToken: "proxy-token",
      grant: "current-generation-grant",
      expiresAt: Date.now() + 60_000,
    });
    const transport = createRunnerTransport(access, fetcher);
    expect(await transport.call<{ revision: string }>(row, "configureMcp", { configuration })).toEqual({
      revision: configuration.revision,
    });
    mode = "conflict";
    await expect(transport.call(row, "configureMcp", { configuration })).rejects.toMatchObject({
      code: "conflict",
      message: "Runner operation refused.",
    });
    mode = "foreign-error";
    await expect(transport.call(row, "configureMcp", { configuration })).rejects.toMatchObject({ code: "unavailable" });
    mode = "wrong-version";
    await expect(transport.call(row, "configureMcp", { configuration })).rejects.toMatchObject({ code: "unavailable" });
    const before = calls;
    const expired = createRunnerTransport(async () => ({ ...(await access()), expiresAt: 0 }), fetcher);
    await expect(expired.call(row, "configureMcp", { configuration })).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toBe(before);
  });
  test("tenant and membership isolation; user roles cannot read control or event tables", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    const other = createSqlModalStore(db, { ...scope, binding: { ...scope.binding, appId: "ap_other" } });
    await expect(other.get(row.id)).rejects.toMatchObject({ code: "not_found" });
    const outsider = createSqlModalStore(db, { ...scope, userId: "00000000-0000-0000-0000-000000000003" });
    await expect(outsider.list()).rejects.toMatchObject({ code: "forbidden" });
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select * from modal_events")).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  });
  test("expired and wrong-generation ingest grants never append", async () => {
    const handler = createModalIngestHandler({
      sql: db,
      verifyGrant: async () => ({
        scope,
        claims: { sandboxId: "expected", generation: "1", expiresAt: Date.now() + 1000 },
      }),
    });
    expect(
      (
        await handler(
          new Request("https://example/ingest", {
            method: "POST",
            body: JSON.stringify({ sandboxId: "other", generation: "1", events: [] }),
          }),
        )
      ).status,
    ).toBe(403);
  });
  test("runner uses nested prompt input, distinct proxy bearer and application header, validates response identity", async () => {
    const f = fixture();
    const info = await f.provider.createGolden({});
    const row = await f.store.get(info.id);
    const transport = createRunnerTransport(
      async () => ({
        url: "https://runner.example",
        connectToken: "connect",
        grant: "application",
        expiresAt: Date.now() + 1000,
      }),
      (async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer connect");
        expect(headers["x-armada-runner-grant"]).toBe("application");
        const body = JSON.parse(String(init?.body));
        expect(body.input.text).toBe("hello");
        return Response.json({ version: 1, requestId: "wrong", result: {} });
      }) as typeof fetch,
    );
    await expect(transport.call(row, "prompt", { input: { text: "hello" } })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

for (const hardExit of [false, true])
  test(`server deadline reconciler retains Modal data after ${hardExit ? "confirmed hard exit" : "graceful checkpoint"}`, async () => {
    const f = fixture();
    const machine = await runningFork(f);
    const goldenId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await db.query(
      `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1::uuid,$2::uuid,$3::uuid,$1::text,'private','modal',$1::text,'label-only','main','ap_pinned','{"repos":[],"init":[]}'::jsonb)`,
      [goldenId, scope.orgId, scope.userId],
    );
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,expires_at)
    values($1,$2,$3,$4,'modal',$5,'claude','running',now()-interval '1 second')`,
      [id, goldenId, scope.orgId, scope.userId, machine.id],
    );
    const before = await f.store.get(machine.id);
    if (hardExit) {
      if (!before.physicalId) throw Error("missing physical machine");
      const physical = await f.client.sandboxes.fromId(before.physicalId);
      if (!physical) throw Error("missing SDK sandbox");
      // External physical expiry: SDK poll reports exit, and the native runner is gone.
      await physical.terminate();
      f.onRpc(async () => {
        throw Error("runner expired");
      });
    }
    const baseline = f.log.length;
    let resolved = 0;
    const lifecycle = createSandboxLifecycle(db, async () => {
      resolved++;
      return f.provider;
    });
    await lifecycle.reconcileOne();
    const row = (
      await db.query<{ status: string; stopped_at: Date | null; status_reason: string | null }>(
        "select status,stopped_at,status_reason from sandboxes where id=$1",
        [id],
      )
    ).rows[0];
    expect(row?.status).toBe(hardExit ? "failed" : "stopped");
    expect(row?.stopped_at).not.toBeNull();
    expect(f.log).not.toContain("delete-image");
    if (hardExit) {
      expect(row?.status_reason).toContain("without a new verified recovery checkpoint");
      expect((await f.store.get(machine.id)).phase).toBe("active");
      expect((await f.store.get(machine.id)).imageId).toBe(before.imageId);
      expect(f.log.slice(baseline)).not.toContain("checkpoint");
      expect(f.log.slice(baseline)).not.toContain("snapshot");
      await db.query("update sandboxes set reconcile_after=now()-interval '1 second' where id=$1", [id]);
      expect(await lifecycle.reconcileOne()).toBe(false);
      expect(resolved).toBe(1);
    } else {
      expect((await f.store.get(machine.id)).phase).toBe("stopped");
      expect(f.log).toContain("terminate");
    }
  });

test("private orchestrator transport requires exact active incarnation and ACK, never restores stopped compute", async () => {
  const f = fixture();
  const golden = await f.provider.createGolden({});
  const image = await f.provider.snapshot({ sandboxId: golden.id, name: `authority-${crypto.randomUUID()}` });
  const parent = await f.provider.fork({ from: image.name });
  const binding = { epoch: "1", physicalGeneration: (await f.provider.get(parent.id)).physicalGeneration ?? "missing" };
  const request = {
    sandboxId: parent.id,
    token: `armada_epoch_${"a".repeat(64)}`,
    binding,
    url: "https://armada.invalid/private/mcp",
  };
  const install = f.provider.installOrchestratorEpoch;
  const scrub = f.provider.scrubOrchestratorEpoch;
  const quiesce = f.provider.quiesceOrchestrator;
  const observe = f.provider.observeOrchestrator;
  const verify = f.provider.verifyOrchestratorSession;
  const resumeRequest = {
    sandboxId: parent.id,
    physicalGeneration: binding.physicalGeneration,
    conversationId: "logical",
    nativeSessionId: "native",
    harness: "codex" as const,
    model: "gpt-6.1-sol",
  };
  if (!install || !scrub || !quiesce || !observe || !verify) throw Error("missing private native authority port");
  await expect(install(request)).rejects.toMatchObject({ code: "unavailable" });
  await expect(observe({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).rejects.toMatchObject(
    { code: "unavailable" },
  );
  let nativeReply = {
    physicalGeneration: binding.physicalGeneration,
    conversationId: "logical",
    nativeSessionId: "replacement",
    verified: true as const,
  };
  f.onRpc(async (_row, op) =>
    op === "resumeNativeSession"
      ? nativeReply
      : op === "observeOrchestrator"
        ? {
            physicalGeneration: binding.physicalGeneration,
            state: "quiescent",
            evidence: "a".repeat(64),
            eventWatermark: 0,
            acknowledgedSequence: 0,
            nativeSessionId: null,
          }
        : ["installOrchestratorEpoch", "scrubOrchestratorEpoch"].includes(op)
          ? { acknowledged: true }
          : undefined,
  );
  expect((await observe({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).state).toBe(
    "quiescent",
  );
  await expect(verify(resumeRequest)).rejects.toMatchObject({ code: "conflict" });
  nativeReply = { ...nativeReply, nativeSessionId: "native" };
  expect(await verify(resumeRequest)).toEqual(nativeReply);
  await expect(verify({ ...resumeRequest, physicalGeneration: "stale-native" })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await install(request)).toEqual({ acknowledged: true });
  await expect(install({ ...request, binding: { ...binding, physicalGeneration: "old" } })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await quiesce({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).toEqual({
    acknowledged: true,
  });
  expect(await scrub({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).toEqual({
    acknowledged: true,
  });
  await f.provider.stop({ sandboxId: parent.id });
  const created = f.creates;
  const calls = f.log.length;
  await expect(install(request)).rejects.toMatchObject({ code: "conflict" });
  await expect(scrub({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).rejects.toMatchObject({
    code: "conflict",
  });
  await expect(quiesce({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).rejects.toMatchObject(
    { code: "conflict" },
  );
  await expect(observe({ sandboxId: parent.id, physicalGeneration: binding.physicalGeneration })).rejects.toMatchObject(
    { code: "conflict" },
  );
  await expect(verify(resumeRequest)).rejects.toMatchObject({ code: "conflict" });
  expect(f.creates).toBe(created);
  expect(f.log.length).toBe(calls);
});
