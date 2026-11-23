import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProviderError, type Sql } from "@armada/core";
import {
  createSqlVaultStore,
  encryptSecret,
  GoldenBuildJobs,
  isNonMutatingProviderRefusal,
  OUTPUT_COLLECTOR,
} from "@armada/core/server";
import { type Image, type ModalClient, NotFoundError, type Sandbox, Volume } from "modal";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createGoldenBuildJob } from "../../mcp-server/src/golden-worker.ts";
import { createJobsRunner } from "../../mcp-server/src/jobs/runner.ts";
import { createJobsStore } from "../../mcp-server/src/jobs/store.ts";
import { closeableFixture } from "../../mcp-server/test/closeable.fixture.ts";
import {
  createModalProvider,
  createRuntimeModalProvider,
  createSqlModalStore,
  type Machine,
  MODAL_IMAGE_LOCK,
  type ModalManagementAuthority,
  mergeModalResourceReceipts,
  modalFailureReceipt,
  type RunnerDistribution,
  type RuntimeModalOptions,
  type Scope,
  scopeKey,
  settleDetachedModalCollections,
} from "../src/index.ts";
import { captureProcessBaseline } from "../src/process-scope.ts";

let workerSnapshot: string;
let goldenTemplate: Machine;
let checkpointedGoldenTemplate: Machine;
let workerTemplate: Machine;
let imageTemplate: Awaited<ReturnType<ReturnType<typeof fixture>["store"]["image"]>>;
const scope: Scope = {
  orgId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  visibility: "private",
  binding: { workspace: "label-only", environment: "main", appId: "ap_pinned" },
};
const {
  setup,
  close,
  get: getDb,
} = closeableFixture(async () => {
  const db = await openMigratedDatabase();
  try {
    await db.exec(`
      set plan_cache_mode = force_generic_plan;
      insert into auth.users(id) values
        ('${scope.userId}'), ('00000000-0000-0000-0000-000000000004');
      insert into orgs(id,name) values ('${scope.orgId}','modal');
      insert into members(org_id,user_id,role) values
        ('${scope.orgId}','${scope.userId}','admin'),
        ('${scope.orgId}','00000000-0000-0000-0000-000000000004','member');
    `);
    const { provider, store } = fixture(
      scope,
      createFixtureSql(() => db),
    );
    const builder = await provider.createGolden({});
    goldenTemplate = await store.get(builder.id);
    workerSnapshot = crypto.randomUUID();
    await provider.snapshot({ sandboxId: builder.id, name: workerSnapshot });
    checkpointedGoldenTemplate = await store.get(builder.id);
    imageTemplate = await store.image(workerSnapshot);
    const worker = await provider.fork({ from: workerSnapshot });
    workerTemplate = await store.get(worker.id);
    await db.query("delete from public.modal_machines where id=$1", [worker.id]);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
});
beforeAll(setup);
afterAll(close);
const prepared = new Map<string, Promise<string>>();
function createFixtureSql(getDatabase: typeof getDb) {
  const sql: Sql = {
    transaction: (work) => getDatabase().transaction(work),
    async query<T>(statement: string, params: unknown[] = []) {
      const db = getDatabase();
      if (
        !params.length ||
        params.some((value) => value !== null && typeof value !== "string" && typeof value !== "number")
      )
        return db.query<T>(statement, params);
      let entry = prepared.get(statement);
      if (!entry) {
        const name = `modal_fixture_${prepared.size}`;
        entry = db.exec(`prepare ${name} as ${statement}`).then(() => name);
        prepared.set(statement, entry);
      }
      const name = await entry;
      const args = params
        .map((value) => {
          if (value === null) return "null";
          const escaped = String(value).replaceAll("\\", "\\\\").replaceAll("'", "''");
          return `E'${escaped}'`;
        })
        .join(",");
      const [result] = await db.exec(`execute ${name}(${args})`);
      return { rows: result!.rows as T[] };
    },
  };
  return sql;
}
const fixtureSql = createFixtureSql(getDb);
function fixture(accessScope: Scope = scope, sql: Sql = fixtureSql) {
  const store = createSqlModalStore(sql, accessScope);
  const log: string[] = [];
  let creates = 0;
  let artifactVolume: Volume | undefined;
  const requestedRuntimes: (string | undefined)[] = [];
  const resourceRequests: Record<string, unknown>[] = [];
  const sdkCommands: { argv: string[]; params: object; stdin: string[] }[] = [];
  let failSnapshot = false;
  let loseTerminateResponse = false;
  let failCreate = false;
  let failBoot = false;
  let appId = "ap_pinned";
  let lookupError: Error | undefined;
  let onLookup: (() => Promise<void>) | undefined;
  let onScrub: (() => Promise<void>) | undefined;
  let onTerminate: (() => Promise<void>) | undefined;
  let onImageDelete: ((id: string) => Promise<void>) | undefined;
  let provisioned = false;
  let ownershipOverride: Record<string, string> | undefined;
  const machines = new Map<string, { sb: Sandbox; exit: number | null }>();
  const names = new Map<string, Sandbox>();
  const fakeClient = {
    apps: {
      fromName: async (_name: string, params: object) => {
        expect(params).toEqual({ environment: "main", createIfMissing: false });
        return { appId };
      },
    },
    images: {
      fromRegistry: () => ({ dockerfileCommands: () => ({ imageId: "im_base" }) }),
      fromId: async (id: string) => ({ imageId: id }),
      delete: async (id: string) => {
        await onImageDelete?.(id);
        log.push("delete-image");
      },
    },
    volumes: {
      fromName: async (name: string, params: object) => {
        expect(name).toBe("armada-runtime-artifacts");
        expect(params).toEqual({ environment: "main", createIfMissing: false });
        if (!artifactVolume) throw new NotFoundError("No cache volume");
        return artifactVolume;
      },
    },
    sandboxes: {
      create: async (
        _app: unknown,
        _image: unknown,
        params: { name: string; env: object; secrets: unknown[]; tags: Record<string, string>; runtime?: string },
      ) => {
        creates++;
        requestedRuntimes.push(params.runtime);
        resourceRequests.push({ ...params });
        expect(params.env).toEqual({});
        expect(params.secrets).toEqual([]);
        const id = `sb_${crypto.randomUUID()}`;
        const state = { sb: {} as Sandbox, exit: null as number | null };
        state.sb = {
          sandboxId: id,
          poll: async () => state.exit,
          getTags: async () => ownershipOverride ?? params.tags,
          exec: async (argv: string[], params: object) => {
            const command = { argv, params, stdin: [] as string[] };
            sdkCommands.push(command);
            let input: Record<string, unknown> | undefined;
            const closed = deferred();
            return {
              stdin: {
                writeText: async (text: string) => {
                  command.stdin.push(text);
                  input = JSON.parse(text);
                  if (input?.op === "quiesce") log.push("quiesce-processes");
                  if (input && "command" in input)
                    log.push(argv.includes("/usr/sbin/runuser") ? "workspace-exec" : "root-exec");
                },
                close: async () => {
                  closed.resolve();
                },
              },
              stdout: {
                readText: async () => {
                  await closed.promise;
                  if (argv.includes(OUTPUT_COLLECTOR)) {
                    log.push("outputs");
                    return JSON.stringify([{ name: "final.pdf", base64: Buffer.from("final").toString("base64") }]);
                  }
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
                          stdout: argv.includes("/usr/sbin/runuser") ? '{"status":"clean"}' : "",
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
            await onTerminate?.();
            log.push("terminate");
            state.exit = 0;
            if (loseTerminateResponse) throw Error("Lost termination confirmation");
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
  };
  const client = fakeClient as unknown as ModalClient;
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
    prepareFreshMachine: async (_sandbox, row) => {
      if (failBoot) throw Error("Synthetic fresh preparation failure");
      log.push(`fresh-${row.generation}`);
    },
    prepareSnapshot: async () => {
      log.push("scrub");
      provisioned = false;
      await onScrub?.();
    },
  };
  const cleanupDelays: number[] = [];
  const detached: (() => Promise<void>)[] = [];
  const { provider, captureRuntimeWork, readResourceReceipts } = createModalProvider({
    cleanupSleep: async (milliseconds) => {
      cleanupDelays.push(milliseconds);
    },
    detachCollection: (work) => {
      detached.push(work);
    },
    scope: accessScope,
    tokenId: "synthetic-id",
    tokenSecret: "synthetic-secret",
    appName: "pinned",
    client,
    store,
    distribution,
    ssh: {
      prepare: async (_sandbox, row) => {
        provisioned = true;
        return { endpoint: "example:22", hostPublicKey: "public", username: row.golden ? "root" : "user" };
      },
    },
  });
  return {
    captureRuntimeWork,
    readResourceReceipts,
    async seedMachine(template: Machine) {
      const id = crypto.randomUUID();
      const physicalName = `fixture-${id}`;
      const { sandboxId: physicalId } = await fakeClient.sandboxes.create(undefined, undefined, {
        name: physicalName,
        env: {},
        secrets: [],
        tags: {
          armada_sandbox: id,
          armada_scope: scopeKey(accessScope),
          armada_generation: String(template.generation),
        },
      });
      const machine: Machine = {
        ...template,
        info: { ...template.info, id, name: id },
        physicalName,
        physicalId,
        ...(template.processBaseline ? { processBaseline: { ...template.processBaseline, physicalId } } : {}),
        ...(template.runtimeEvidence ? { runtimeEvidence: { ...template.runtimeEvidence, physicalId } } : {}),
      };
      await sql.query(
        `insert into public.modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
         values($1,$2,$3,$4,$5,$5,$6::jsonb)`,
        [
          scopeKey(accessScope),
          accessScope.orgId,
          accessScope.userId,
          accessScope.visibility,
          id,
          JSON.stringify(machine),
        ],
      );
      return machine.info;
    },
    cleanupDelays,
    runDetached: async () => {
      for (let work = detached.shift(); work; work = detached.shift()) await work();
    },
    provider,
    store,
    client,
    distribution,
    log,
    requestedRuntimes,
    resourceRequests,
    setArtifactVolume: (volume: Volume) => {
      artifactVolume = volume;
    },
    sdkCommands,
    get provisioned() {
      return provisioned;
    },
    loseTerminateResponse(value: boolean) {
      loseTerminateResponse = value;
    },
    onTerminate(work: () => Promise<void>) {
      onTerminate = work;
    },
    onImageDelete(work: ((id: string) => Promise<void>) | undefined) {
      onImageDelete = work;
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
test("detail verifies the App once per read and still rejects a changed binding", async () => {
  const f = fixture();
  const row = await activeWorker(f);
  const lookup = f.client.apps.fromName;
  let appReads = 0;
  f.client.apps.fromName = async (...args) => {
    appReads++;
    return lookup(...args);
  };
  expect(await f.provider.get(row.id)).toMatchObject({ id: row.id, state: "ready" });
  expect(appReads).toBe(1);
  f.wrongApp();
  await expect(f.provider.get(row.id)).rejects.toMatchObject({ code: "forbidden" });
  expect(appReads).toBe(2);
});

test("detail refuses exit evidence from a different physical machine", async () => {
  const f = fixture();
  const row = await activeWorker(f);
  const lookup = f.client.sandboxes.fromId;
  f.client.sandboxes.fromId = async (id) => {
    const sandbox = await lookup(id);
    return { ...sandbox, sandboxId: "sb_other", poll: async () => 0 } as Sandbox;
  };
  await expect(f.provider.get(row.id)).rejects.toMatchObject({ code: "conflict" });
});

async function goldenBuildGitHub(key: string): Promise<typeof fetch> {
  await getDb().query(
    "insert into github_connections(user_id,github_id,login,refresh_token_enc,access_token_enc,access_expires_at) values($1,77,'builder',$2,$3,now()+interval '8 hours') on conflict (user_id) do update set refresh_token_enc=excluded.refresh_token_enc,access_token_enc=excluded.access_token_enc,access_expires_at=excluded.access_expires_at",
    [scope.userId, await encryptSecret("fixture-refresh", key), await encryptSecret("fixture-access", key)],
  );
  const githubFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://api.github.com/user") return Response.json({ id: 77, login: "builder", name: null });
    if (url.startsWith("https://api.github.com/user/installations")) return Response.json({ installations: [] });
    if (url === "https://api.github.com/repos/acme/web")
      return Response.json({ id: 1, name: "web", owner: { login: "acme" }, default_branch: "main", private: false });
    throw new Error("Unexpected fixture GitHub route");
  }) as typeof fetch;
  return githubFetch;
}

function goldenBuildRunner(builds: GoldenBuildJobs, receiptId: string) {
  const idle = new AbortController().signal;
  let now = Date.UTC(2100, 0, 1);

  async function tick() {
    const errors: string[] = [];
    const runner = createJobsRunner(
      createJobsStore(getDb()),
      {
        golden_build: createGoldenBuildJob(
          builds,
          () => now,
          () => idle,
        ),
      },
      (message) => errors.push(message),
      () => () => {},
    );
    const claimed = await runner.reconcileOne(idle);
    await runner.drain();
    expect(errors).toEqual([]);
    return claimed;
  }

  async function retry() {
    now += 60_000;
    const { rows } = await getDb().query(
      "update public.jobs set run_after='-infinity' where id=$1 and state='queued' and run_after=$2 returning id",
      [receiptId, new Date(now)],
    );
    expect(rows).toEqual([{ id: receiptId }]);
    expect(await tick()).toBe(true);
  }

  async function expectDone() {
    const { rows } = await getDb().query("select state from public.jobs where id=$1", [receiptId]);
    expect(rows).toEqual([{ state: "done" }]);
    expect(await tick()).toBe(false);
  }

  return { tick, retry, expectDone };
}

test("a failed Modal builder image records safe diagnostics and frees capacity without creating a sandbox", async () => {
  const f = fixture();
  const key = Buffer.alloc(32, 60).toString("base64");
  const githubFetch = await goldenBuildGitHub(key);
  const provider = Object.assign(f.provider, { maxGoldens: 1 });
  const upstream = "fatal error: openssl/ssl.h: No such file or directory";
  const privateDetail = "synthetic_private_payload";
  const image = {
    imageId: "",
    async build() {
      throw new Error(`Image build for im-fixture failed with the exception:\n${upstream}\n${privateDetail}`);
    },
  };
  f.distribution.image = async () => image as unknown as Image;
  const sdkCreate = spyOn(f.client.sandboxes, "create").mockImplementation(async () => {
    await image.build();
    throw new Error("Fixture image build unexpectedly completed");
  });
  const jobs = new GoldenBuildJobs({
    sql: getDb(),
    encryptionKey: key,
    service: {
      github: {
        store: createSqlVaultStore(getDb()),
        encryptionKey: key,
        app: { clientId: "fixture", clientSecret: "fixture" },
        fetch: githubFetch,
      },
      fetch: githubFetch,
      installationApp: null,
    },
    provider: async () => provider,
  });
  const actor = { userId: scope.userId, orgId: scope.orgId, role: "admin" as const };
  const input = { name: "image-failed", visibility: "private" as const, repos: ["acme/web"], modal: scope.binding };
  const job = await jobs.admit(provider, actor, input, crypto.randomUUID());
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { tick, expectDone } = goldenBuildRunner(jobs, job.jobId);
    expect(await tick()).toBe(true);
    await expectDone();
    const diagnostic = `Modal builder image failed. ${upstream}`;
    expect(await jobs.status(scope.userId, job.jobId)).toMatchObject({
      phase: "builder",
      state: "failed",
      failureReason: `detail:${diagnostic}`,
    });
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({ event: "golden_build_failed", buildId: job.jobId, detail: diagnostic }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
    expect(sdkCreate).not.toHaveBeenCalled();
    expect(await f.store.findByRequestKey(job.jobId)).toMatchObject({ phase: "deleted" });
    expect((await getDb().query("select id from golden_backend_slots where org_id=$1", [scope.orgId])).rows).toEqual(
      [],
    );
  } finally {
    log.mockRestore();
  }
});

test("durable golden recovery persists an interrupted Modal builder before exact owned cleanup, never replays create", async () => {
  const f = fixture();
  const key = Buffer.alloc(32, 61).toString("base64");
  const githubFetch = await goldenBuildGitHub(key);
  const actor = { userId: scope.userId, orgId: scope.orgId, role: "admin" as const };
  let concurrentAfterPersist: (() => Promise<void>) | undefined;
  const recoverySql: Sql = {
    query: getDb().query.bind(getDb()),
    transaction: async (work) => {
      const result = await getDb().transaction(work);
      const run = concurrentAfterPersist;
      if (run) {
        const persisted = await getDb().query<{ builder_id: string | null }>(
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
      github: {
        store: createSqlVaultStore(getDb()),
        encryptionKey: key,
        app: { clientId: "fixture", clientSecret: "fixture" },
        fetch: githubFetch,
      },
      fetch: githubFetch,
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
  const { tick, retry, expectDone } = goldenBuildRunner(jobs, job.jobId);
  const fence = crypto.randomUUID();
  await getDb().query(
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
      await getDb().query<{ builder_id: string | null; state: string; fence: string }>(
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
    await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
      reserved.info.id,
      JSON.stringify(corrupt),
    ]);
    await expect(f.provider.findGoldenBuilder(request)).rejects.toMatchObject({ code: "forbidden" });
  }
  await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify(originalRecord),
  ]);
  await getDb().query("update modal_machines set owner_id=$2 where id=$1", [
    reserved.info.id,
    "00000000-0000-0000-0000-000000000004",
  ]);
  expect(await f.provider.findGoldenBuilder(request)).toBeNull();
  await getDb().query("update modal_machines set owner_id=$2 where id=$1", [reserved.info.id, scope.userId]);
  const discover = f.provider.findGoldenBuilder;
  f.provider.findGoldenBuilder = async (req) => {
    const found = await discover(req);
    await getDb().query("update golden_build_jobs set fence=$2 where id=$1", [job.jobId, crypto.randomUUID()]);
    return found;
  };
  expect(await tick()).toBe(true);
  expect((await row()).builder_id).toBeNull();
  expect(f.log).not.toContain("terminate");
  await getDb().query("update golden_build_jobs set fence=$2 where id=$1", [job.jobId, fence]);
  f.provider.findGoldenBuilder = discover;
  for (const phase of ["snapshot", "persist"]) {
    await getDb().query("update golden_build_jobs set phase=$2 where id=$1", [job.jobId, phase]);
    await retry();
    expect((await row()).builder_id).toBeNull();
    expect(f.log).not.toContain("terminate");
  }
  await getDb().query("update golden_build_jobs set phase='builder' where id=$1", [job.jobId]);
  await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify({ ...originalRecord, snapshotImages: [{ name: "retained-proof", imageId: "im_proof" }] }),
  ]);
  let competingClaim: boolean | undefined;
  let retainedDiscoveries = 0;
  f.provider.findGoldenBuilder = async (req) => {
    retainedDiscoveries++;
    return discover(req);
  };
  concurrentAfterPersist = async () => {
    competingClaim = await tick();
  };
  await retry();
  await retry();
  expect(competingClaim).toBe(false);
  expect(retainedDiscoveries).toBe(2);
  f.provider.findGoldenBuilder = discover;
  expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required" });
  expect(f.log).not.toContain("terminate");
  expect(f.log).not.toContain("delete-image");
  await getDb().query(
    "update modal_machines set record=$2::jsonb,lease_id=$3,lease_until=now()+interval '15 minutes' where id=$1",
    [reserved.info.id, JSON.stringify(originalRecord), crypto.randomUUID()],
  );
  await retry();
  expect((await row()).state).toBe("recovery_required");
  expect(f.log).not.toContain("terminate");
  await getDb().query("update modal_machines set lease_until=now()-interval '1 second' where id=$1", [
    reserved.info.id,
  ]);
  f.provider.findGoldenBuilder = async (req) => {
    const found = await discover(req);
    await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
      reserved.info.id,
      JSON.stringify({ ...originalRecord, recoveryImageId: "im_late_proof" }),
    ]);
    return found;
  };
  await retry();
  expect((await row()).state).toBe("recovery_required");
  expect(f.log).not.toContain("terminate");
  expect(f.log).not.toContain("delete-image");
  f.provider.findGoldenBuilder = discover;
  await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
    reserved.info.id,
    JSON.stringify(originalRecord),
  ]);
  f.onLookup(async () => {
    expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required", fence });
  });
  for (const name of ["NotFoundError", "TimeoutError"]) {
    f.lookupError(Object.assign(new Error("synthetic SDK private payload"), { name }));
    await retry();
    expect(await row()).toMatchObject({ builder_id: reserved.info.id, state: "recovery_required" });
    expect((await f.store.get(reserved.info.id)).phase).toBe("creating");
    expect(f.log).not.toContain("terminate");
  }
  f.lookupError(undefined);
  const known = await f.client.sandboxes.fromName("pinned", reserved.physicalName, {
    environment: "main",
    includeTerminated: true,
  });
  await getDb().query("update modal_machines set record=$2::jsonb where id=$1", [
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
    await retry();
    expect((await row()).state).toBe("recovery_required");
    expect(f.log).not.toContain("terminate");
  }
  f.ownership();
  await retry();
  expect((await row()).state).toBe("failed");
  expect((await f.store.get(reserved.info.id)).phase).toBe("deleted");
  expect(f.creates).toBe(1);
  expect(f.log.filter((x) => x === "terminate")).toHaveLength(1);
  expect(f.log).not.toContain("root-exec");
  expect(f.log).not.toContain("snapshot");
  await expectDone();
  expect(f.creates).toBe(1);
  expect(f.log.filter((x) => x === "terminate")).toHaveLength(1);
});

test.each(["interrupted", "abandoned"] as const)(
  "a rolled-back Modal build artifact is collected by the job reconciler before its %s builder is deleted",
  async (mode) => {
    const f = fixture();
    const key = Buffer.alloc(32, 62).toString("base64");
    await getDb().query(
      "insert into github_connections(user_id,github_id,login,refresh_token_enc,access_token_enc,access_expires_at) values($1,77,'builder',$2,$3,now()+interval '8 hours') on conflict (user_id) do update set refresh_token_enc=excluded.refresh_token_enc,access_token_enc=excluded.access_token_enc,access_expires_at=excluded.access_expires_at",
      [scope.userId, await encryptSecret("fixture-refresh", key), await encryptSecret("fixture-access", key)],
    );
    const githubFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.github.com/user") return Response.json({ id: 77, login: "builder", name: null });
      if (url.startsWith("https://api.github.com/user/installations")) return Response.json({ installations: [] });
      if (url === "https://api.github.com/repos/acme/web")
        return Response.json({ id: 1, name: "web", owner: { login: "acme" }, default_branch: "main", private: false });
      throw new Error("Unexpected fixture GitHub route");
    }) as typeof fetch;
    const jobs = new GoldenBuildJobs({
      sql: getDb(),
      encryptionKey: key,
      service: {
        github: {
          store: createSqlVaultStore(getDb()),
          encryptionKey: key,
          app: { clientId: "fixture", clientSecret: "fixture" },
          fetch: githubFetch,
        },
        fetch: githubFetch,
        installationApp: null,
        ssh: async () => {
          throw Error("Build commands must not replay");
        },
      },
      provider: async () => f.provider,
    });
    const actor = { userId: scope.userId, orgId: scope.orgId, role: "admin" as const };
    const job = await jobs.admit(
      f.provider,
      actor,
      { name: "rolled-back", visibility: "private", repos: ["acme/web"], modal: scope.binding },
      crypto.randomUUID(),
    );
    const { tick, retry, expectDone } = goldenBuildRunner(jobs, job.jobId);
    const builder = await f.provider.createGolden({ idempotencyKey: job.jobId, labels: { armada: "golden-builder" } });
    const artifact = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: artifact });
    f.onImageDelete(async () => {
      throw new ProviderError({
        provider: "modal",
        code: "unavailable",
        message: "image service down",
        retryable: true,
      });
    });
    let terminations = 0;
    f.onTerminate(async () => {
      if (++terminations === 1 && mode === "interrupted")
        throw new ProviderError({
          provider: "modal",
          code: "unavailable",
          message: "terminate failed",
          retryable: true,
        });
    });
    const parked = mode === "interrupted" ? "deleting" : "checkpoint";
    if (mode === "interrupted") {
      await f.provider.deleteSnapshot(artifact);
      await expect(f.provider.collectRetiredSnapshot(artifact)).rejects.toMatchObject({ code: "unavailable" });
      await expect(f.provider.delete({ sandboxId: builder.id })).rejects.toBeDefined();
    }
    expect((await f.store.get(builder.id)).phase).toBe(parked);
    await getDb().query(
      "update golden_build_jobs set state='recovery_required',phase='persist',error_code='build_failed',fence=$2,builder_id=$3,snapshot=$4 where id=$1",
      [job.jobId, crypto.randomUUID(), builder.id, artifact],
    );
    const state = async () =>
      (await getDb().query<{ state: string }>("select state from golden_build_jobs where id=$1", [job.jobId])).rows[0]
        ?.state;
    expect(await tick()).toBe(true);
    expect(await state()).toBe("recovery_required");
    expect((await f.store.get(builder.id)).phase).toBe(parked);
    await expect(f.provider.getSnapshot(artifact)).rejects.toMatchObject({ code: "not_found" });
    f.onImageDelete(undefined);
    await retry();
    expect(await state()).toBe("failed");
    await expectDone();
    expect(await f.provider.collectRetiredSnapshot(artifact)).toBe("collected");
    expect((await f.store.get(builder.id)).phase).toBe("deleted");
    expect(terminations).toBe(mode === "interrupted" ? 2 : 1);
  },
);

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
  await f.provider.stopRuntime({ sandboxId: row.id, physicalGeneration: "1", epoch: "1", watermark: 0 });
  await f.provider.resumeRuntime({
    sandboxId: row.id,
    generation: 2,
    checkpoint: { epoch: "1", watermark: 0 },
    ttlSeconds: 3600,
  });
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

function runningFork(f: ReturnType<typeof fixture>) {
  return f.provider.fork({ from: workerSnapshot });
}
function activeWorker(f: ReturnType<typeof fixture>) {
  return f.seedMachine(workerTemplate);
}

async function savedGolden(f: ReturnType<typeof fixture>) {
  const name = crypto.randomUUID();
  const imageId = `im_${crypto.randomUUID()}`;
  const builder = await f.seedMachine({ ...checkpointedGoldenTemplate, snapshotImages: [{ name, imageId }] });
  const image = {
    ...imageTemplate,
    sourceId: builder.id,
    imageId,
    info: { ...imageTemplate.info, name, artifactId: imageId, sourceSandboxId: builder.id },
  };
  await fixtureSql.query("insert into public.modal_images(scope,name,source_id,record) values($1,$2,$3,$4::jsonb)", [
    scopeKey(scope),
    name,
    builder.id,
    JSON.stringify(image),
  ]);
  return { builder, name };
}

async function seedHistoricalSnapshotTombstone(name: string) {
  await getDb().query(
    `update public.modal_images set record=jsonb_set(record,'{deleted}','true') where scope=$1 and name=$2`,
    [scopeKey(scope), name],
  );
}

test("Modal forks from one snapshot can boot concurrently", async () => {
  const f = fixture(scope, fixtureSql);
  const { name } = await savedGolden(f);
  const entered = deferred();
  const release = deferred();
  const prepare = f.distribution.prepareFreshMachine!;
  let firstBoot = true;
  f.distribution.prepareFreshMachine = async (sandbox, row) => {
    if (firstBoot) {
      firstBoot = false;
      entered.resolve();
      await release.promise;
    }
    await prepare(sandbox, row);
  };
  const first = f.provider.fork({ from: name });
  try {
    await Promise.race([entered.promise, first]);
    expect(firstBoot).toBe(false);
    const second = await f.provider.fork({ from: name });
    expect(second.state).toBe("ready");
    release.resolve();
    const firstChild = await first;
    expect(firstChild.state).toBe("ready");
    expect(firstChild.id).not.toBe(second.id);
  } finally {
    release.resolve();
    await first;
  }
});

test("Modal fork refuses a snapshot retired before reservation", async () => {
  const source = fixture();
  const { name } = await savedGolden(source);
  const fork = fixture(scope, {
    query: fixtureSql.query,
    async transaction(work) {
      await source.provider.deleteSnapshot(name);
      return getDb().transaction(work);
    },
  });
  const requestKey = crypto.randomUUID();
  await expect(fork.provider.fork({ from: name, idempotencyKey: requestKey })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await fork.store.findByRequestKey(requestKey)).toBeNull();
  expect(fork.creates).toBe(0);
});

test("snapshot retirement refuses a live Modal fork reference", async () => {
  const f = fixture(scope, fixtureSql);
  const { name } = await savedGolden(f);
  const child = await f.provider.fork({ from: name });
  const error = await f.provider.deleteSnapshot(name).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "conflict", providerCode: "snapshot_source_busy" });
  expect(isNonMutatingProviderRefusal(error)).toBe(true);
  expect((await f.provider.getSnapshot(name)).name).toBe(name);
  await f.provider.delete({ sandboxId: child.id });
  await f.provider.deleteSnapshot(name);
  await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "not_found" });
});

test("enrolled Modal forks mount the environment artifact cache read-only", async () => {
  const f = fixture(scope, getDb());
  const volume = new Volume("vo_public_artifacts");
  f.setArtifactVolume(volume);
  await runningFork(f);
  expect(f.resourceRequests.at(-1)?.volumes).toEqual({
    "/opt/armada/artifact-cache": volume.withMountOptions({ readOnly: true }),
  });
});

test("enrolled Modal bootstrap rejects a different physical machine before consuming the attempt", async () => {
  const f = fixture(scope, fixtureSql);
  const row = await runningFork(f);
  const lookup = f.client.sandboxes.fromId;
  f.client.sandboxes.fromId = async (id) => ({ ...(await lookup(id)), sandboxId: "sb_other" }) as Sandbox;
  const execs = f.sdkCommands.length;

  await expect(
    f.provider.startRuntime({
      sandboxId: row.id,
      serverUrl: "https://armada.example",
      enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
      cacheDir: "/home/user/.armada-runtime-bootstrap",
      artifact: { sha256: "b".repeat(64), bytes: 1 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.sdkCommands).toHaveLength(execs);
  expect((await f.store.get(row.id)).runtimeStartAttempted).toBeUndefined();
});

test("enrolled Modal forks bootstrap once and stop without a recovery claim", async () => {
  const f = fixture(scope, fixtureSql);
  const row = await runningFork(f);
  expect(await f.store.get(row.id)).toMatchObject({ commonRuntime: true, phase: "active" });
  const afterFork = f.log.length;
  await f.provider.startRuntime({
    sandboxId: row.id,
    serverUrl: "https://armada.example",
    enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
    cacheDir: "/home/user/.armada-runtime-bootstrap",
    artifact: { sha256: "b".repeat(64), bytes: 1 },
  });
  const bootstrap = f.sdkCommands.at(-1);
  expect(bootstrap?.argv.at(-1)).toContain("stdio:['pipe','ignore','ignore',9]");
  expect(bootstrap?.argv.at(-1)).toContain("/opt/armada/artifact-cache");
  expect(JSON.stringify(bootstrap?.argv)).not.toContain(`armada_enrol_${"a".repeat(64)}`);
  expect(bootstrap?.params).toMatchObject({ env: {}, secrets: [], stderr: "ignore", stdout: "ignore" });
  expect(JSON.parse(bootstrap?.stdin[0] ?? "")).toEqual({
    serverUrl: "https://armada.example",
    enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
  });
  await expect(
    f.provider.startRuntime({
      sandboxId: row.id,
      serverUrl: "https://armada.example",
      enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
      cacheDir: "/home/user/.armada-runtime-bootstrap",
      artifact: { sha256: "b".repeat(64), bytes: 1 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await f.provider.stop({ sandboxId: row.id });
  expect(f.log.slice(afterFork)).toEqual(["terminate"]);
  expect(await f.provider.get(row.id)).toMatchObject({ state: "stopped" });
  expect((await f.store.get(row.id)).recoveryImageId).toBeUndefined();
  expect(f.creates).toBe(1);
});

test("common-runtime Modal capture quiesces the active incarnation and runs the Git policy as the workspace user", async () => {
  const f = fixture(scope, getDb());
  f.distribution.captureProcessBaseline = captureProcessBaseline;
  const worker = await runningFork(f);
  const afterFork = f.log.length;

  await expect(
    f.captureRuntimeWork({
      sandboxId: worker.id,
      physicalGeneration: worker.physicalGeneration!,
      signal: new AbortController().signal,
      context: { source: "user_stop", captureId: crypto.randomUUID() },
    }),
  ).resolves.toEqual({ status: "clean" });
  expect(f.log.slice(afterFork)).toEqual(["quiesce-processes", "workspace-exec"]);
  expect(await f.store.get(worker.id)).toMatchObject({ phase: "active" });
});

test("common-runtime Modal capture refuses a stale incarnation before touching physical compute", async () => {
  const f = fixture(scope, getDb());
  const worker = await runningFork(f);
  const afterFork = f.sdkCommands.length;

  await expect(
    f.captureRuntimeWork({
      sandboxId: worker.id,
      physicalGeneration: "2",
      signal: new AbortController().signal,
      context: { source: "lifecycle_stop", captureId: crypto.randomUUID() },
    }),
  ).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(f.sdkCommands).toHaveLength(afterFork);
});

test("Modal delete keeps ownership when physical lookup returns a different machine", async () => {
  const f = fixture(scope, fixtureSql);
  const worker = await runningFork(f);
  const lookup = f.client.sandboxes.fromId;
  f.client.sandboxes.fromId = async (id) => ({ ...(await lookup(id)), sandboxId: "sb_other" }) as Sandbox;
  const before = f.log.length;

  await expect(f.provider.delete({ sandboxId: worker.id })).rejects.toMatchObject({ code: "conflict" });
  expect(f.log.slice(before)).not.toContain("terminate");
  const row = await f.store.get(worker.id);
  expect(row.phase).toBe("deleting");
  expect(row.deletePhysicalExitGeneration).toBeUndefined();
});

test("retained enrolled Modal stop snapshots only after quiescence and resumes its exact checkpoint without tunnel or history purge", async () => {
  const f = fixture(scope, fixtureSql);
  const worker = await runningFork(f);
  const original = await f.store.get(worker.id);
  const bootstrap = {
    sandboxId: worker.id,
    serverUrl: "https://armada.example",
    enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
    cacheDir: "/home/user/.armada-runtime-bootstrap",
    artifact: { sha256: "b".repeat(64), bytes: 1 },
  };
  await f.provider.startRuntime(bootstrap);
  const afterLaunch = f.log.length;
  f.onScrub(async () => {
    expect(await f.store.get(worker.id)).toMatchObject({
      phase: "checkpoint",
      runtimeCheckpoint: { epoch: "7", watermark: 2, physicalId: original.physicalId, generation: 1 },
    });
  });
  f.onTerminate(async () => {
    expect(await f.store.get(worker.id)).toMatchObject({
      phase: "terminate",
      quiesced: true,
      recoveryImageId: `im_${original.physicalId}`,
    });
  });
  await expect(
    f.provider.stopRuntime({ sandboxId: worker.id, physicalGeneration: "2", epoch: "7", watermark: 2 }),
  ).rejects.toMatchObject({ code: "conflict" });
  await f.provider.stopRuntime({ sandboxId: worker.id, physicalGeneration: "1", epoch: "7", watermark: 2 });
  await f.provider.stopRuntime({ sandboxId: worker.id, physicalGeneration: "1", epoch: "7", watermark: 2 });
  expect(f.log.slice(afterLaunch)).toEqual(["scrub", "snapshot", "terminate"]);
  await expect(
    f.provider.resumeRuntime({
      sandboxId: worker.id,
      generation: 2,
      ttlSeconds: 900,
      checkpoint: { epoch: "7", watermark: 3 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.creates).toBe(1);
  const request = { sandboxId: worker.id, generation: 2, ttlSeconds: 900, checkpoint: { epoch: "7", watermark: 2 } };
  f.failCreate(true);
  await expect(f.provider.resumeRuntime(request)).rejects.toThrow();
  expect(f.creates).toBe(2);
  f.failCreate(false);
  const resumed = await f.provider.resumeRuntime(request);
  expect(resumed).toMatchObject({ id: worker.id, state: "ready", physicalGeneration: "2" });
  const restored = await f.store.get(worker.id);
  expect(restored.physicalId).not.toBe(original.physicalId);
  expect(restored.imageId).toBe(`im_${original.physicalId}`);
  expect(restored.runtimeStartAttempted).toBeUndefined();
  expect((await f.provider.resumeRuntime(request)).physicalGeneration).toBe("2");
  expect(f.creates).toBe(2);
  expect(f.log.slice(afterLaunch)).toEqual(["scrub", "snapshot", "terminate"]);
  await f.provider.startRuntime({ ...bootstrap, resumeGeneration: request.generation });
  f.onTerminate(async () => {
    const stopping = await f.store.get(worker.id);
    expect(stopping.runtimeCheckpoint).toBeUndefined();
    expect(stopping.recoveryImageId).toBeUndefined();
  });
  await f.provider.stop({ sandboxId: worker.id });
  await expect(f.provider.resumeRuntime(request)).rejects.toMatchObject({ code: "conflict" });
});

test("retained Modal rollback retries termination and fences a newer replacement", async () => {
  const f = fixture(scope, fixtureSql);
  const worker = await runningFork(f);
  const checkpoint = { epoch: "1", watermark: 2 };
  await f.provider.stopRuntime({ sandboxId: worker.id, physicalGeneration: "1", ...checkpoint });
  const { recoveryImageId } = await f.store.get(worker.id);
  const request = { sandboxId: worker.id, generation: 2, ttlSeconds: 900, checkpoint };
  await f.provider.resumeRuntime(request);
  const replacement = await f.store.get(worker.id);
  const before = f.log.length;
  f.loseTerminateResponse(true);
  await expect(f.provider.rollbackRuntimeResume(request)).rejects.toThrow();
  expect(await f.store.get(worker.id)).toMatchObject({ phase: "terminate", recoveryImageId });
  await f.provider.rollbackRuntimeResume(request);
  await f.provider.rollbackRuntimeResume(request);
  expect(f.log.slice(before)).toEqual(["terminate"]);
  expect(await f.store.get(worker.id)).toMatchObject({
    phase: "stopped",
    recoveryImageId,
    runtimeCheckpoint: { ...checkpoint, physicalId: replacement.physicalId, generation: 2 },
  });
  await expect(f.provider.resumeRuntime(request)).rejects.toMatchObject({ code: "conflict" });
  await f.provider.resumeRuntime({ ...request, generation: 4 });
  await expect(f.provider.rollbackRuntimeResume(request)).rejects.toMatchObject({ code: "conflict" });
  const bootstrap = {
    sandboxId: worker.id,
    serverUrl: "https://armada.example",
    enrolmentToken: `armada_enrol_${"a".repeat(64)}`,
    cacheDir: "/tmp/armada-runtime",
    artifact: { sha256: "b".repeat(64), bytes: 1 },
  };
  await expect(f.provider.startRuntime({ ...bootstrap, resumeGeneration: request.generation })).rejects.toMatchObject({
    code: "conflict",
  });
  await f.provider.startRuntime({ ...bootstrap, resumeGeneration: 4 });
  expect(await f.provider.get(worker.id)).toMatchObject({ state: "ready", physicalGeneration: "3" });
  expect((await f.store.get(worker.id)).imageId).toBe(recoveryImageId);
});

test("cleanup reconciles an unknown enrolled Modal resume create without activating or allocating again", async () => {
  const f = fixture(scope, fixtureSql);
  const worker = await runningFork(f);
  await f.provider.stopRuntime({ sandboxId: worker.id, physicalGeneration: "1", epoch: "1", watermark: 2 });
  f.failCreate(true);
  await expect(
    f.provider.resumeRuntime({
      sandboxId: worker.id,
      generation: 2,
      ttlSeconds: 900,
      checkpoint: { epoch: "1", watermark: 2 },
    }),
  ).rejects.toThrow();
  expect(await f.store.get(worker.id)).toMatchObject({ phase: "creating", generation: 2 });
  expect((await f.store.get(worker.id)).physicalId).toBeUndefined();
  expect(f.creates).toBe(2);
  const beforeCleanup = f.log.length;
  await f.provider.stop({ sandboxId: worker.id });
  expect(f.log.slice(beforeCleanup)).toEqual(["terminate"]);
  expect(f.creates).toBe(2);
  const stopped = await f.store.get(worker.id);
  expect(stopped.phase).toBe("stopped");
  expect(stopped.physicalId).toBeDefined();
  expect(stopped.runtimeCheckpoint).toBeUndefined();
  expect(stopped.recoveryImageId).toBeUndefined();
  expect(await f.provider.get(worker.id)).toMatchObject({ state: "stopped" });
});

test("uncertain enrolled Modal snapshot refuses retry or resume and compute fallback drops retention", async () => {
  const f = fixture(scope, fixtureSql);
  const worker = await runningFork(f);
  const proof = { sandboxId: worker.id, physicalGeneration: "1", epoch: "1", watermark: 2 };
  const afterLaunch = f.log.length;
  f.failSnapshot(true);
  await expect(f.provider.stopRuntime(proof)).rejects.toThrow();
  await expect(f.provider.stopRuntime(proof)).rejects.toMatchObject({ code: "conflict" });
  expect(f.log.slice(afterLaunch)).toEqual(["scrub", "snapshot"]);
  await expect(
    f.provider.resumeRuntime({
      sandboxId: worker.id,
      generation: 2,
      ttlSeconds: 900,
      checkpoint: { epoch: "1", watermark: 2 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await f.provider.stop({ sandboxId: worker.id });
  expect((await f.store.get(worker.id)).runtimeCheckpoint).toBeUndefined();
  expect((await f.store.get(worker.id)).recoveryImageId).toBeUndefined();
  expect(f.log.slice(afterLaunch)).toEqual(["scrub", "snapshot", "terminate"]);
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function runtimeComposition(f: ReturnType<typeof fixture>) {
  return createRuntimeModalProvider({
    scope,
    client: f.client,
    sql: fixtureSql,
    appName: "pinned",
    image: MODAL_IMAGE_LOCK,
    publicUrl: "https://armada.example",
  });
}

function compositionOptions(
  f: ReturnType<typeof fixture>,
  target: Scope = scope,
  sourceScope: Scope = target,
): RuntimeModalOptions {
  return {
    scope: target,
    sourceScope,
    appName: "pinned",
    sql: fixtureSql,
    publicUrl: "https://armada.example",
    client: f.client,
    image: MODAL_IMAGE_LOCK,
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
  test.each([false, true])("keyed fork reuses its physical machine (lost response=%s)", async (lostResponse) => {
    const f = fixture();
    const { name: from } = await savedGolden(f);
    const request = { from, idempotencyKey: crypto.randomUUID() };
    const creates = f.creates;
    if (lostResponse) {
      f.failCreate(true);
      await expect(f.provider.fork(request)).rejects.toMatchObject({ code: "unknown" });
      f.failCreate(false);
    } else {
      await f.provider.fork(request);
    }
    const physicalName = f.resourceRequests.at(-1)?.name;
    if (typeof physicalName !== "string") throw new Error("Expected a named Modal create");
    const original = await f.client.sandboxes.fromName("pinned", physicalName, {
      environment: scope.binding.environment,
      includeTerminated: true,
    });
    const replay = await f.provider.fork(request);
    expect(replay.state).toBe("ready");
    expect(f.creates - creates).toBe(1);
    expect((await f.store.get(replay.id)).physicalId).toBe(original.sandboxId);
  });
  test("keyed fork cannot reactivate a machine deleted before its child lease", async () => {
    const f = fixture();
    const { name: from } = await savedGolden(f);
    const idempotencyKey = crypto.randomUUID();
    const request = { from, idempotencyKey };
    f.failCreate(true);
    await expect(f.provider.fork(request)).rejects.toMatchObject({ code: "unknown" });
    f.failCreate(false);
    const child = await f.store.findByRequestKey(idempotencyKey);
    if (!child) throw new Error("Expected a saved fork reservation");
    const lease = f.store.lease.bind(f.store);
    f.store.lease = async (id, work) => {
      if (id === child.info.id) {
        f.store.lease = lease;
        await f.provider.delete({ sandboxId: id });
      }
      return lease(id, work);
    };
    await expect(f.provider.fork(request)).rejects.toMatchObject({ code: "conflict" });
    expect((await f.store.get(child.info.id)).phase).toBe("deleted");
  });
  test("a shared-scope reservation key cannot be replayed by another owner", async () => {
    const orgScope: Scope = { ...scope, visibility: "org" };
    const first = fixture(orgScope);
    const other = fixture({ ...orgScope, userId: "00000000-0000-0000-0000-000000000004" });
    const request = { idempotencyKey: crypto.randomUUID() };
    await first.provider.createGolden(request);
    await expect(other.provider.createGolden(request)).rejects.toMatchObject({ code: "conflict" });
    expect(other.creates).toBe(0);
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
          return getDb().query<T>(statement, params);
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
  test("sshKey cannot reprovision authorization or a hostkey between snapshot scrub and save", async () => {
    const f = fixture();
    const row = await f.provider.createGolden({});
    await f.provider.sshKey({ sandboxId: row.id, key: "synthetic" });
    expect(f.provisioned).toBe(true);
    f.onScrub(async () => {
      expect(f.provisioned).toBe(false);
      await expect(f.provider.sshKey({ sandboxId: row.id, key: "synthetic" })).rejects.toMatchObject({
        code: "sandbox_not_ready",
      });
      expect(f.provisioned).toBe(false);
    });
    await f.provider.snapshot({ sandboxId: row.id, name: crypto.randomUUID() });
    expect(f.log).toContain("snapshot");
    expect(f.provisioned).toBe(false);
  });
  test("historically retired snapshots leave existing forks usable", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    const fork = await f.provider.fork({ from: name });
    await seedHistoricalSnapshotTombstone(name);
    expect(f.log).not.toContain("delete-image");
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "not_found" });
    expect((await f.provider.get(fork.id)).state).toBe("ready");
    await f.provider.delete({ sandboxId: fork.id });
    expect(f.log).not.toContain("delete-image");
    await f.runDetached();
    expect(await f.store.tombstoneSources()).not.toContain(builder.id);
  });
  test("a retired image still referenced by a live fork never leases its source", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    const first = await f.provider.fork({ from: name });
    const second = await f.provider.fork({ from: name });
    await seedHistoricalSnapshotTombstone(name);
    await f.provider.delete({ sandboxId: first.id });
    const lease = f.store.lease.bind(f.store);
    const leased: string[] = [];
    f.store.lease = (id, work) => {
      leased.push(id);
      return lease(id, work);
    };
    await f.runDetached();
    expect(leased).not.toContain(builder.id);
    expect(f.log).not.toContain("delete-image");
    await f.provider.delete({ sandboxId: second.id });
    await f.runDetached();
    expect(leased).toContain(builder.id);
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(1);
  });
  test("a busy retired source neither fails nor delays a fork's deletion", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    const fork = await f.provider.fork({ from: name });
    await seedHistoricalSnapshotTombstone(name);
    await f.provider.stop({ sandboxId: fork.id });
    expect(await f.store.tombstoneSources()).toContain(builder.id);
    const terminations = f.log.filter((x) => x === "terminate").length;
    const imageDeletes = () => f.log.filter((x) => x === "delete-image").length;
    await f.store.lease(builder.id, async () => {
      expect(await f.provider.delete({ sandboxId: fork.id })).toEqual({ status: "deleted" });
      await f.runDetached();
    });
    expect(f.cleanupDelays).toEqual([]);
    const ownImages = imageDeletes();
    expect((await f.store.get(fork.id)).phase).toBe("deleted");
    expect(f.log.filter((x) => x === "terminate")).toHaveLength(terminations);
    expect(await f.store.tombstoneSources()).toContain(builder.id);
    await f.store.lease(builder.id, async () => {
      expect(await f.provider.collectRetiredSnapshot(name)).toBe("pending");
    });
    expect(imageDeletes()).toBe(ownImages);
    expect(await f.provider.collectRetiredSnapshot(name)).toBe("collected");
    expect(imageDeletes()).toBe(ownImages + 1);
    expect(await f.store.tombstoneSources()).not.toContain(builder.id);
  });
  test("another source's failing retired image never blocks a snapshot's collection retry", async () => {
    const f = fixture();
    const { builder: a, name: first } = await savedGolden(f);
    const { builder: b, name: broken } = await savedGolden(f);
    const brokenImage = (await f.store.image(broken)).imageId;
    f.onImageDelete(async (id) => {
      if (id === brokenImage) throw new Error("image service refused");
    });
    await f.provider.deleteSnapshot(broken);
    const fork = await f.provider.fork({ from: first });
    await seedHistoricalSnapshotTombstone(first);
    await f.provider.delete({ sandboxId: fork.id });
    expect(await f.store.tombstoneSources()).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await f.provider.collectRetiredSnapshot(first)).toBe("collected");
    expect(await f.store.tombstoneSources()).toEqual([b.id]);
  });
  test("a failing retired image never blocks collection of another snapshot from the same source", async () => {
    const f = fixture();
    const { builder, name: broken } = await savedGolden(f);
    const next = crypto.randomUUID();
    await f.provider.delete({ sandboxId: builder.id });
    await f.provider.restoreGoldenMaster({ snapshotId: broken });
    await f.provider.snapshot({ sandboxId: builder.id, name: next });
    await f.provider.delete({ sandboxId: builder.id });
    const brokenImage = (await f.store.image(broken)).imageId;
    const nextImage = (await f.store.image(next)).imageId;
    const attempts: string[] = [];
    let nextFailures = 1;
    f.onImageDelete(async (id) => {
      attempts.push(id);
      if (id === brokenImage) throw new Error("image service refused");
      if (id === nextImage && nextFailures-- > 0) throw new Error("image service unavailable");
    });
    await f.provider.deleteSnapshot(broken);
    await f.provider.deleteSnapshot(next);
    attempts.length = 0;
    expect(await f.provider.collectRetiredSnapshot(next)).toBe("collected");
    expect(attempts).toEqual([nextImage!]);
    expect((await f.store.images(builder.id)).filter((x) => x.deleted).map((x) => x.info.name)).toEqual([broken]);
  });
  test("a stale collector's purge never erases a later tombstone that reused the name", async () => {
    const f = fixture();
    const [a, b] = [await f.provider.createGolden({}), await f.provider.createGolden({})];
    const name = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: a.id, name });
    const stale = await f.store.image(name);
    await f.store.removeImage(name);
    await f.store.purgeImage(name, stale.sourceId, stale.imageId!);
    await f.provider.snapshot({ sandboxId: b.id, name });
    await f.store.removeImage(name);
    await f.store.purgeImage(name, stale.sourceId, stale.imageId!);
    const retired = (await f.store.images(b.id)).filter((x) => x.deleted);
    expect(retired.map((x) => x.info.name)).toEqual([name]);
    expect(retired[0]!.imageId).not.toBe(stale.imageId);
  });
  test("a held retired-image deletion never fences its source's lifecycle", async () => {
    const f = fixture();
    const { builder, name: first } = await savedGolden(f);
    const restore = crypto.randomUUID(),
      second = crypto.randomUUID();
    await f.provider.delete({ sandboxId: builder.id });
    await f.provider.restoreGoldenMaster({ snapshotId: first });
    await f.provider.snapshot({ sandboxId: builder.id, name: restore });
    await f.provider.delete({ sandboxId: builder.id });
    await f.provider.restoreGoldenMaster({ snapshotId: restore });
    await f.provider.snapshot({ sandboxId: builder.id, name: second });
    const fork = await f.provider.fork({ from: first });
    await seedHistoricalSnapshotTombstone(first);
    await f.runDetached();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstImage = (await f.store.images(builder.id)).find((x) => x.info.name === first)?.imageId;
    let held = false;
    f.onImageDelete(async (id) => {
      if (id !== firstImage || held) return;
      held = true;
      entered.resolve();
      await release.promise;
    });
    expect(await f.provider.delete({ sandboxId: fork.id })).toEqual({ status: "deleted" });
    const collecting = f.runDetached();
    await entered.promise;
    expect((await f.store.images(builder.id)).find((x) => x.info.name === first)?.collecting).toBe(true);
    await f.provider.deleteSnapshot(second);
    await expect(f.provider.getSnapshot(second)).rejects.toMatchObject({ code: "not_found" });
    expect(await f.provider.delete({ sandboxId: builder.id })).toEqual({ status: "deleted" });
    expect((await f.store.get(builder.id)).phase).toBe("deleted");
    release.resolve();
    await collecting;
    f.onImageDelete(undefined);
    await f.runDetached();
    expect((await f.store.images(builder.id)).filter((x) => x.deleted)).toEqual([]);
  });
  test("a claimed retired image whose deletion failed is retried without its source lease", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    let failures = 1;
    f.onImageDelete(async () => {
      if (failures-- > 0) throw Object.assign(new Error("image service unavailable"), { name: "TimeoutError" });
    });
    await f.provider.deleteSnapshot(name);
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "not_found" });
    expect((await f.store.images(builder.id)).find((x) => x.info.name === name)?.collecting).toBe(true);
    await f.store.lease(builder.id, () => f.provider.collectRetiredSnapshot(name));
    expect(await f.store.tombstoneSources()).not.toContain(builder.id);
  });
  test("a concurrent sweep skips a live dispatch claim and recovers an expired one", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    const imageId = (await f.store.image(name)).imageId;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    f.onImageDelete(async (id) => {
      if (id !== imageId) return;
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        throw Object.assign(new Error("image service unavailable"), { name: "TimeoutError" });
      }
    });
    const retiring = f.provider.deleteSnapshot(name);
    await entered.promise;
    await expect(f.provider.collectRetiredSnapshot(name)).resolves.toBe("pending");
    expect(calls).toBe(1);
    const expire = () =>
      getDb().query(
        `update public.modal_images set record=jsonb_set(record,'{collectUntil}','0') where record->>'imageId'=$1`,
        [imageId],
      );
    await expire();
    expect(await f.store.takeImage(name, builder.id, imageId!, "newer")).toBe(true);
    release.resolve();
    await retiring;
    const claimed = (await f.store.images(builder.id)).find((x) => x.info.name === name);
    expect(claimed?.collectToken).toBe("newer");
    await expire();
    await expect(f.provider.collectRetiredSnapshot(name)).resolves.toBe("collected");
    expect(calls).toBe(2);
    expect(await f.store.tombstoneSources()).not.toContain(builder.id);
  });
  test("a snapshot retired after restore read it never gains a restore reference", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    await f.provider.delete({ sandboxId: builder.id });
    const lease = f.store.lease.bind(f.store);
    f.store.lease = async (id, work) => {
      f.store.lease = lease;
      await f.store.removeImage(name);
      return lease(id, work);
    };
    const creates = f.creates;
    await expect(f.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({ code: "not_found" });
    const row = await f.store.get(builder.id);
    expect(row.phase).toBe("deleted");
    expect(row.goldenRestore).toBeUndefined();
    expect(f.creates).toBe(creates);
  });
  test("a busy snapshot source refuses retirement before any tombstone, as non-mutating", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    let refused: unknown;
    await f.store.lease(builder.id, async () => {
      refused = await f.provider.deleteSnapshot(name).catch((error) => error);
    });
    expect(refused).toMatchObject({ code: "conflict", providerCode: "snapshot_source_busy", retryable: true });
    expect(isNonMutatingProviderRefusal(refused)).toBe(true);
    expect((await f.provider.getSnapshot(name)).name).toBe(name);
    await f.provider.deleteSnapshot(name);
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "not_found" });
  });
  test("recovery references do not depend on a saved label surviving retirement", async () => {
    const f = fixture();
    const { name } = await savedGolden(f);
    const saved = await f.store.image(name);
    const child = await f.provider.fork({ from: name });
    await f.provider.stopRuntime({ sandboxId: child.id, physicalGeneration: "1", epoch: "1", watermark: 0 });
    const recovery = (await f.store.get(child.id)).recoveryImageId;
    expect(recovery).toBeDefined();
    await seedHistoricalSnapshotTombstone(name);
    expect(f.log).not.toContain("delete-image");
    await f.store.purgeImage(name, saved.sourceId, saved.imageId!);
    expect(await f.store.imageReferenced(saved.imageId!)).toBe(true);
    expect(await f.store.imageReferenced(recovery!)).toBe(true);
    await f.provider.resumeRuntime({
      sandboxId: child.id,
      generation: 2,
      checkpoint: { epoch: "1", watermark: 0 },
      ttlSeconds: 3600,
    });
    expect((await f.provider.get(child.id)).state).toBe("ready");
  });
  test("retiring one saved handle preserves another live handle sharing its artifact", async () => {
    const f = fixture();
    const { name: old } = await savedGolden(f);
    const current = crypto.randomUUID();
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
    const { builder, name } = await savedGolden(f);
    const original = await f.store.image(name);
    expect(original.imageId).toBeDefined();
    expect(original.managementAuthority).toBeDefined();
    await getDb().query("update modal_images set record=record-'imageId'-'managementAuthority' where name=$1", [name]);
    const info = await f.provider.getSnapshot(name);
    expect(info.artifactId).toBeUndefined();
    expect(info.managementAuthority).toBeUndefined();
    expect(info.sourceSandboxId).toBe(builder.id);
  });
  test.each(["current", "retained"])(
    "saved-handle collection protects shared physical recovery references across tenant scopes (%s)",
    async (mode) => {
      const otherOrg = crypto.randomUUID();
      await getDb().query("insert into orgs(id,name) values($1,$2)", [otherOrg, "shared-ref-" + otherOrg]);
      const otherUser = "00000000-0000-0000-0000-000000000004";
      await getDb().query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [otherOrg, otherUser]);
      const other = fixture({ ...scope, orgId: otherOrg, userId: otherUser });
      const seed = await other.provider.createGolden({});
      const seedName = crypto.randomUUID();
      await other.provider.snapshot({ sandboxId: seed.id, name: seedName });
      const child = await other.provider.fork({ from: seedName });
      await other.provider.stopRuntime({ sandboxId: child.id, physicalGeneration: "1", epoch: "1", watermark: 0 });
      const recovery = (await other.store.get(child.id)).recoveryImageId!;
      if (mode === "retained") {
        await other.provider.resumeRuntime({
          sandboxId: child.id,
          generation: 2,
          checkpoint: { epoch: "1", watermark: 0 },
          ttlSeconds: 3600,
        });
        await other.provider.stopRuntime({ sandboxId: child.id, physicalGeneration: "2", epoch: "2", watermark: 0 });
        await other.provider.resumeRuntime({
          sandboxId: child.id,
          generation: 3,
          checkpoint: { epoch: "2", watermark: 0 },
          ttlSeconds: 3600,
        });
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
    await expect(f.provider.getSnapshot(name)).rejects.toMatchObject({ code: "provider_routing_unavailable" });
    await expect(f.provider.deleteSnapshot(name)).rejects.toMatchObject({ code: "provider_routing_unavailable" });
    expect((await f.store.image(name)).info.status).toBe("ready");
    expect(f.log).not.toContain("delete-image");
  });
  test("concurrent lifecycle lease cannot write through the active holder", async () => {
    const f = fixture();
    const row = await f.seedMachine(goldenTemplate);
    await f.store.lease(row.id, async () => {
      await expect(f.store.lease(row.id, async () => undefined)).rejects.toMatchObject({ code: "conflict" });
    });
  });
  test("actual composition forks ORG snapshot into owner-private access while management authority stays ORG and GC counts private references", async () => {
    const orgScope: Scope = { ...scope, visibility: "org" };
    const f = fixture(orgScope);
    const builder = await f.provider.createGolden({});
    const snapshot = crypto.randomUUID();
    await f.provider.snapshot({ sandboxId: builder.id, name: snapshot });
    const authorities: ModalManagementAuthority[] = [];
    const detached: (() => Promise<void>)[] = [];
    const configuration: RuntimeModalOptions = {
      detachCollection: (work) => {
        detached.push(work);
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
    };
    const { provider, close } = await createRuntimeModalProvider(configuration);
    const launched = await provider.fork({ from: snapshot, name: "private-working-fork" });
    const privateStore = createSqlModalStore(getDb(), scope);
    const machine = await privateStore.get(launched.id);
    expect(machine.sourceImage).toMatchObject({ name: snapshot });
    expect(machine.processBaseline).toMatchObject({ physicalId: machine.physicalId, generation: machine.generation });
    expect(machine.launchUserId).toBe(scope.userId);
    await expect(f.store.get(launched.id)).rejects.toMatchObject({ code: "not_found" });
    const otherScope = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const other = await createRuntimeModalProvider({
      ...configuration,
      scope: otherScope,
      sourceScope: { ...orgScope, userId: otherScope.userId },
    });
    await expect(other.provider.get(launched.id)).rejects.toMatchObject({ code: "not_found" });
    other.close();
    await expect(createSqlModalStore(getDb(), otherScope).get(launched.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await createSqlModalStore(getDb(), otherScope).list()).some((x) => x.info.id === launched.id)).toBe(false);
    await expect(createSqlModalStore(getDb(), scope).image(snapshot)).rejects.toMatchObject({ code: "not_found" });
    const { resolveManagementCredentials: _resolveSource, ...operatorWithSource } = configuration;
    const wrongSource = await createRuntimeModalProvider({ ...operatorWithSource, sourceScope: scope });
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
    await expect(f.provider.deleteSnapshot(snapshot)).rejects.toMatchObject({ providerCode: "snapshot_source_busy" });
    expect(f.log).not.toContain("delete-image");
    await provider.delete({ sandboxId: launched.id });
    for (const work of detached.splice(0)) await work();
    await f.provider.deleteSnapshot(snapshot);
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(1);
    close();
    const { resolveManagementCredentials: _resolver, ...operatorConfiguration } = configuration;
    const operator = await createRuntimeModalProvider(operatorConfiguration);
    await expect(operator.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    operator.close();
    const { client: _client, ...withoutClient } = operatorConfiguration;
    await expect(createRuntimeModalProvider(withoutClient)).rejects.toMatchObject({
      code: "provider_routing_unavailable",
    });
    await expect(
      createRuntimeModalProvider({ ...operatorConfiguration, tokenId: "incomplete-pair" }),
    ).rejects.toMatchObject({ code: "provider_routing_unavailable" });
    await expect(
      createRuntimeModalProvider({
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
      createRuntimeModalProvider({ ...configuration, sourceScope: { ...scope, userId: otherScope.userId } }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("private golden with explicit org fallback authority stays owner-private across fork/restore and rejects scope/key substitution", async () => {
    const f = fixture();
    const requested = { credentialScope: "org" as const, credentialOwnerId: scope.orgId };
    const seen: ModalManagementAuthority[] = [];
    const configuration: RuntimeModalOptions = {
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
    const { provider, close } = await createRuntimeModalProvider(configuration);
    const builder = await provider.createGolden({});
    const snapshot = crypto.randomUUID();
    await provider.snapshot({ sandboxId: builder.id, name: snapshot });
    expect((await f.store.get(builder.id)).managementAuthority).toEqual(requested);
    expect((await f.store.image(snapshot)).managementAuthority).toEqual(requested);
    const { provider: restoredConnection } = await createRuntimeModalProvider(configuration);
    const fork = await restoredConnection.fork({ from: snapshot });
    expect((await f.store.get(fork.id)).managementAuthority).toEqual(requested);
    await restoredConnection.stopRuntime({ sandboxId: fork.id, physicalGeneration: "1", epoch: "1", watermark: 0 });
    await restoredConnection.resumeRuntime({
      sandboxId: fork.id,
      generation: 2,
      checkpoint: { epoch: "1", watermark: 0 },
      ttlSeconds: 3600,
    });
    expect((await f.store.get(fork.id)).managementAuthority).toEqual(requested);
    for (const authority of seen)
      expect(authority).toMatchObject({
        sourceGoldenVisibility: "private",
        credentialScope: "org",
        credentialOwnerId: scope.orgId,
      });
    const otherScope = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const other = await createRuntimeModalProvider({ ...configuration, scope: otherScope, sourceScope: otherScope });
    await expect(other.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    await expect(other.provider.get(fork.id)).rejects.toMatchObject({ code: "not_found" });
    const orgView = await createRuntimeModalProvider({
      ...configuration,
      scope: { ...scope, visibility: "org" },
      sourceScope: { ...scope, visibility: "org" },
    });
    await expect(orgView.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "not_found" });
    const userKey = await createRuntimeModalProvider({
      ...compositionOptions(f),
      managementAuthority: { credentialScope: "user", credentialOwnerId: scope.userId },
    });
    await expect(userKey.provider.getSnapshot(snapshot)).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.fork({ from: snapshot })).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.get(fork.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(userKey.provider.delete({ sandboxId: fork.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createRuntimeModalProvider({
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
      createRuntimeModalProvider({
        ...configuration,
        scope: { ...scope, visibility: "org" },
        sourceScope: { ...scope, visibility: "org" },
        managementAuthority: { credentialScope: "user", credentialOwnerId: scope.userId },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createRuntimeModalProvider({
        ...configuration,
        managementAuthority: { credentialScope: "org", credentialOwnerId: otherScope.userId },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(JSON.stringify((await getDb().query("select record from public.modal_machines")).rows)).not.toContain(
      "synthetic-fallback-secret",
    );
    let calls = f.log.filter((x) => x === "delete-image").length;
    await seedHistoricalSnapshotTombstone(snapshot);
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(calls);
    await settleDetachedModalCollections();
    calls = f.log.filter((x) => x === "delete-image").length;
    await expect(userKey.provider.collectRetiredSnapshot(snapshot)).resolves.toBe("pending");
    expect(f.log.filter((x) => x === "delete-image")).toHaveLength(calls);
    await restoredConnection.delete({ sandboxId: fork.id });
    expect(f.log.filter((x) => x === "delete-image").length).toBeGreaterThan(calls);
    close();
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
    const beforeDelete = f.log.length;
    await f.provider.delete({ sandboxId: builder.id });
    expect(f.log.slice(beforeDelete)).toContain("terminate");
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
    const { builder, name } = await savedGolden(f);
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
  test("golden restore recovers a lost final active commit without replacing its machine", async () => {
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
        return getDb().query<T>(statement, params);
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
    const count = f.creates;
    const restored = await f.provider.restoreGoldenMaster({ snapshotId: name });
    expect(restored.physicalGeneration).toBe("2");
    expect(f.creates).toBe(count);
  });
  test("runtime-only composition builds, snapshots, retains and restores a golden without runner bootstrap", async () => {
    const f = fixture();
    const { provider, close } = await runtimeComposition(f);
    try {
      const builder = await provider.createGolden({});
      expect(builder.state).toBe("ready");
      expect(await provider.exec({ sandboxId: builder.id, command: "true" })).toMatchObject({ exitCode: 0 });
      const name = crypto.randomUUID();
      const beforeSnapshot = f.log.length;
      const snapshot = await provider.snapshot({ sandboxId: builder.id, name });
      expect(snapshot.status).toBe("ready");
      expect(f.log.slice(beforeSnapshot)).toEqual(["quiesce-processes", "snapshot"]);
      await provider.stop({ sandboxId: builder.id, requireRetention: true });
      expect((await provider.get(builder.id)).state).toBe("stopped");

      const restored = await provider.restoreGoldenMaster({ sandboxId: builder.id, snapshotId: name });
      expect(restored).toMatchObject({ id: builder.id, physicalGeneration: "2", state: "ready" });
      expect(await provider.restoreGoldenMaster({ snapshotId: name })).toEqual(restored);
      expect(await provider.exec({ sandboxId: builder.id, command: "true" })).toMatchObject({ exitCode: 0 });

      const fork = await provider.fork({ from: name });
      expect(await f.store.get(fork.id)).toMatchObject({ commonRuntime: true, phase: "active" });
    } finally {
      close();
    }
  });
  test("runtime-only composition restores a golden checkpoint recorded before cutover", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
    const snapshot = await f.store.image(name);
    const { provider, close } = await runtimeComposition(f);
    try {
      const restored = await provider.restoreGoldenMaster({ snapshotId: name });
      expect(restored).toMatchObject({ id: builder.id, physicalGeneration: "2", state: "ready" });
      expect(await f.store.get(restored.id)).toMatchObject({ imageId: snapshot.imageId, phase: "active" });
    } finally {
      close();
    }
  });
  test("runtime-only stop refuses an unenrolled fork before recording a stop attempt", async () => {
    const f = fixture();
    const worker = await f.seedMachine(workerTemplate);
    await f.store.lease(worker.id, async (row, save) => {
      delete row.commonRuntime;
      await save(row);
    });
    const before = await f.store.get(worker.id);
    const { provider, close } = await runtimeComposition(f);
    try {
      await expect(provider.stop({ sandboxId: worker.id })).rejects.toMatchObject({ code: "invalid_request" });
      expect(await f.store.get(worker.id)).toEqual(before);
    } finally {
      close();
    }
  });
  test("actual source-scoped golden restore keeps org-fallback provenance and boots without model/session credentials", async () => {
    const f = fixture();
    const connection = await createRuntimeModalProvider({
      ...compositionOptions(f),
      managementAuthority: { credentialScope: "org", credentialOwnerId: scope.orgId },
    });
    const builder = await connection.provider.createGolden({});
    const name = crypto.randomUUID();
    await connection.provider.snapshot({ sandboxId: builder.id, name });
    await connection.provider.delete({ sandboxId: builder.id });
    const restored = await connection.provider.restoreGoldenMaster({ snapshotId: name });
    const row = await f.store.get(restored.id);
    expect(restored.id).toBe(builder.id);
    expect(restored.physicalGeneration).toBe("2");
    expect(row.managementAuthority).toEqual({ credentialScope: "org", credentialOwnerId: scope.orgId });
    expect(row.processBaseline).toMatchObject({ physicalId: row.physicalId, generation: 2 });
    const other = { ...scope, userId: "00000000-0000-0000-0000-000000000004" };
    const outsider = await createRuntimeModalProvider({
      ...compositionOptions(f, other),
      managementAuthority: { credentialScope: "org", credentialOwnerId: scope.orgId },
    });
    await expect(outsider.provider.restoreGoldenMaster({ snapshotId: name })).rejects.toMatchObject({
      code: "not_found",
    });
    connection.close();
    outsider.close();
  });
  test("failed fork boot exports exact reservation/physical/image provenance for scoped disposable cleanup", async () => {
    const f = fixture();
    const { builder, name } = await savedGolden(f);
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
    const exported = JSON.parse(JSON.stringify(await f.readResourceReceipts()));
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
        return getDb().query<T>(statement, params);
      },
    };
    const f = fixture(scope, sql);
    const builder = await f.seedMachine(goldenTemplate);
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
    const persisted = await f.readResourceReceipts();
    const merged = mergeModalResourceReceipts([receipt, ...persisted]);
    expect(merged.find((x) => x.sandboxId === builder.id)?.snapshotImages).toEqual(receipt.snapshotImages);
  });
  test("tenant and membership isolation; user roles cannot read control or event tables", async () => {
    const f = fixture();
    const row = await f.seedMachine(goldenTemplate);
    const other = createSqlModalStore(getDb(), { ...scope, binding: { ...scope.binding, appId: "ap_other" } });
    await expect(other.get(row.id)).rejects.toMatchObject({ code: "not_found" });
    const outsider = createSqlModalStore(getDb(), { ...scope, userId: "00000000-0000-0000-0000-000000000003" });
    await expect(outsider.list()).rejects.toMatchObject({ code: "forbidden" });
    await getDb().exec("set role authenticated");
    try {
      await expect(getDb().query("select * from modal_events")).rejects.toThrow("permission denied");
    } finally {
      await getDb().exec("reset role");
    }
  });
});

test("declared outputs are read on live compute only, never by resuming a stopped recovery image", async () => {
  const f = fixture();
  const fork = await activeWorker(f);
  const read = await f.store.lease(fork.id, async () => f.provider.readOutputs?.({ sandboxId: fork.id }));
  expect(read?.map((file) => [file.name, Buffer.from(file.bytes).toString()])).toEqual([["final.pdf", "final"]]);
  expect(f.sdkCommands.at(-1)?.argv.at(-1)).toBe(OUTPUT_COLLECTOR);
  await f.provider.stop({ sandboxId: fork.id });
  const creates = f.creates;
  expect(await f.provider.readOutputs?.({ sandboxId: fork.id })).toBeNull();
  expect(f.creates).toBe(creates);
  expect(f.log.filter((x) => x === "outputs")).toHaveLength(1);
});
