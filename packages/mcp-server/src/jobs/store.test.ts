import { expect, spyOn, test } from "bun:test";
import { createMemoryAuthStore, sha256Hex } from "@armada/auth";
import { HARNESSES } from "@armada/core";
import { modalLaunchReceipt } from "@armada/core/contract";
import {
  createSqlVaultStore,
  decryptSecret,
  encryptSecret,
  outputEntryCollector,
  ProviderError,
  resolveBoatKey,
  type Sql,
  setCredential,
} from "@armada/core/server";
import {
  createModalProvider,
  createSqlModalStore,
  type ModalMachineOptions,
  prepareFilesystemSnapshot,
  scopeKey,
} from "@armada/provider-modal";
import { archivedBoat, runBoatStop } from "../../test/boat-stop.fixture.ts";
import { rowOnlyDatabase } from "../../test/row-only-database.ts";
import { ENCRYPTION_KEY, fakeBoat } from "../../test/support.ts";
import { admitClaimedAccountTurn, createTurnDispatchJob, type DispatchTurn } from "../account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../account-turn-queue.ts";
import type { Caller } from "../caller.ts";
import { createQueuedSandboxDispatch } from "../control.ts";
import { readLogs } from "../control-logs.ts";
import { createSqlData } from "../data.ts";
import { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import { launchRoute } from "../launch-control.ts";
import { launchCredentials } from "../launch-credentials.ts";
import { createModalLaunchAdmission } from "../modal-launch-admission.ts";
import { ordinaryLaunchFingerprint } from "../ordinary-launch-receipts.ts";
import { observeGoldenLaunch } from "../request-timing.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "../retention-maintenance.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "../runtime-checkpoint.ts";
import { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "../runtime-enrolment.ts";
import { createRuntimeEvents } from "../runtime-events.ts";
import { createRuntimeFollowup } from "../runtime-followup.ts";
import { createRuntimeGitHub } from "../runtime-github.ts";
import { createModalJobReader, createModalLogReader } from "../runtime-history.ts";
import { createRuntimeMcp, type RuntimeMcp } from "../runtime-mcp.ts";
import { createRuntimeProgress } from "../runtime-progress.ts";
import { runtimeConfigurationWithVariables } from "../runtime-readable-variables.ts";
import { createRuntimeServing } from "../runtime-serving.ts";
import { createSandboxArmadaAccess } from "../sandbox-armada-access.ts";
import { extendSandbox } from "../sandbox-extend.ts";
import { createSandboxLifecycle, enqueueBoatStop, requestBoatLaunchFailure } from "../sandbox-lifecycle.ts";
import { createSandboxOutputs } from "../sandbox-outputs.ts";
import { deleteSandboxWithActivity } from "../sandbox-rest-controls.ts";
import type { LaneFactory } from "../server-worker-modules.ts";
import { sqlOver } from "../sql.ts";
import { callSharedTool } from "../tool-api.ts";
import { runtimeWakes } from "../wake-bus.ts";
import { createBoatStop } from "./boat-stop.ts";
import {
  admitModalLaunch as admitModalLaunchWithMcp,
  createModalInitialTurnJob,
  createModalLaunchCleanupJob,
  createModalLaunchJob,
  MODAL_INITIAL_TURN,
  type ModalLaunchAdmission,
  modalLaunchTicketGuard,
  replayModalLaunch,
  runFailedModalLaunchDelete,
  runModalLaunch,
} from "./modal-launch.ts";
import { createJobsRunner, type Job, type JobContext } from "./runner.ts";
import { createStopJob } from "./stop.ts";
import { createJobsStore, JOBS_WAKE, withJobLease } from "./store.ts";

const database = rowOnlyDatabase();
const signal = new AbortController().signal;

async function fixture(statements?: string[]) {
  const { db, people, openaiCredentialId } = await database();
  const recordingDriver = (connection: Pick<typeof db, "query">) => ({
    unsafe: async (query: string, params: unknown[]) => {
      statements?.push(query);
      return (await connection.query(query, params)).rows;
    },
  });
  const sql = sqlOver({
    ...recordingDriver(db),
    begin: (work) => db.transaction((tx) => work(recordingDriver(tx))),
  });
  return { db, people, openaiCredentialId, sql, store: createJobsStore(sql, btoa("\0".repeat(32))) };
}

async function sandbox({ db, people }: Awaited<ReturnType<typeof fixture>>, boatRuntime = false, stopped = false) {
  const {
    rows: [golden],
  } = await db.query<{ id: string }>("select id from goldens where owner_id = $1", [people.owner]);
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status, lifecycle_generation, expires_at, boat_runtime, stopped_at)
     values ($1, $1::uuid::text, $2, $3, $4, 'codex',
       case when $6 then 'stopped'::sandbox_status else 'ready'::sandbox_status end, 2, 'infinity', $5,
       case when $6 then now() end)`,
    [id, golden!.id, people.org, people.owner, boatRuntime, stopped],
  );
  return id;
}

async function seedTurn(f: Awaited<ReturnType<typeof fixture>>, sandboxId: string, requestId: string) {
  await f.db.query(
    `insert into account_turn_queue
       (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,
        input_hash,input_enc,conversation_id,queued_generation)
     values ($1,$2,$3,$4,$5,1,1,'fixture',''::bytea,'fixture',2)`,
    [sandboxId, requestId, f.openaiCredentialId, f.people.owner, f.people.org],
  );
}

test("Boat extension storage persists job intent and complete, service-only physical evidence", async () => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const jobId = await f.store.enqueue("boat_runtime_extend", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 1,
    deadline: new Date("2030-01-01T00:00:00Z"),
  });
  await expect(
    f.db.query("insert into boat_runtime_extension_state (sandbox_id,pending_job_id) values ($1,$2)", [
      id,
      crypto.randomUUID(),
    ]),
  ).rejects.toMatchObject({ code: "23503" });
  await f.db.query("insert into boat_runtime_extension_state (sandbox_id,pending_job_id) values ($1,$2)", [id, jobId]);
  await expect(
    f.db.query("update boat_runtime_extension_state set observed_expires_at=now() where sandbox_id=$1", [id]),
  ).rejects.toMatchObject({ code: "23514" });
  await f.db.query(
    `update boat_runtime_extension_state
       set observed_provider_id=s.provider_sandbox_id,
           observed_generation=s.lifecycle_generation,
           observed_at='2026-11-22T00:00:00Z',
           observed_expires_at='2026-11-23T00:00:00Z'
       from sandboxes s where s.id=$1 and sandbox_id=s.id`,
    [id],
  );
  await expect(
    f.db.query("update boat_runtime_extension_state set observed_expires_at='infinity' where sandbox_id=$1", [id]),
  ).rejects.toMatchObject({ code: "23514" });
  await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [id]);
  const { rows } = await f.db.query(
    `select pending_job_id as job_id, observed_generation::int as generation, observed_provider_id as provider_id,
            observed_expires_at='2026-11-23T00:00:00Z' as deadline_matches
       from boat_runtime_extension_state where sandbox_id=$1`,
    [id],
  );
  expect(rows).toEqual([{ job_id: jobId, generation: 2, provider_id: id, deadline_matches: true }]);
  const { rows: grants } = await f.db.query(
    `select role, has_table_privilege(role, 'public.boat_runtime_extension_state', 'select,insert,update,delete') as access
       from unnest(array['anon','authenticated','service_role']) as role order by role`,
  );
  expect(grants).toEqual([
    { role: "anon", access: false },
    { role: "authenticated", access: false },
    { role: "service_role", access: true },
  ]);
});

test("a Boat extension lease is capped and an elapsed deadline permits recovery only", async () => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const kind = "boat_runtime_extend";
  const owner = crypto.randomUUID();
  const {
    rows: [clock],
  } = await f.db.query<{ deadline: Date }>("select now()+interval '1 day' as deadline");
  const jobId = await f.store.enqueue(kind, id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: clock!.deadline,
  });
  const readCap = async () =>
    (await f.db.query<{ capped: boolean }>("select lease_until=deadline_at as capped from jobs where id=$1", [jobId]))
      .rows[0]?.capped;

  const uncapped = (await f.store.claim(kind, owner, 30, 1))!;
  expect(uncapped.dispatchBudgetMs).toBeUndefined();
  expect(await f.store.complete(uncapped, owner, { status: "retry", after: new Date(0) })).toBe(true);

  const first = (await f.store.claim(kind, owner, 172800, 1))!;
  expect(first.id).toBe(jobId);
  expect(first.dispatchBudgetMs).toBeGreaterThan(0);
  expect(first.dispatchBudgetMs).toBeLessThanOrEqual(86_400_000);
  expect(await readCap()).toBe(true);
  await f.db.query("update jobs set lease_until=deadline_at-interval '1 hour' where id=$1", [jobId]);
  expect(await f.store.renew(first, owner, 172800)).toBe(true);
  expect(await readCap()).toBe(true);

  await f.db.query("update jobs set lease_until='-infinity', deadline_at='-infinity' where id=$1", [jobId]);
  expect(await f.store.renew(first, owner, 172800)).toBe(false);
  expect(await f.store.inspect(first, owner)).toBe("lost");
  await f.db.query("insert into public.boat_runtime_extension_state (sandbox_id,pending_job_id) values ($1,$2)", [
    id,
    jobId,
  ]);
  let handlerEntered = false;
  const runner = createJobsRunner(
    f.store,
    {
      [kind]: {
        concurrency: 1,
        async run() {
          handlerEntered = true;
          return { status: "done" };
        },
      },
    },
    undefined,
    () => () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(handlerEntered).toBe(false);
  const { rows } = await f.db.query(
    `select j.state, j.lease_owner, j.lease_until, e.pending_job_id
     from public.jobs j join public.boat_runtime_extension_state e on e.sandbox_id=j.sandbox_id
     where j.id=$1`,
    [jobId],
  );
  expect(rows).toEqual([{ state: "failed", lease_owner: null, lease_until: null, pending_job_id: jobId }]);
});

test.each([false, true])(
  "an attempt-exhausted Boat extension respects the completion fence (takeover: %s)",
  async (takeover) => {
    const f = await fixture();
    const id = await sandbox(f, true);
    const kind = "boat_runtime_extend";
    const successor = crypto.randomUUID();
    const evidence = { phase: "observed" };
    const jobId = await f.store.enqueue(kind, id, 2, id, null, {
      orgId: f.people.org,
      maxAttempts: 1,
      deadline: new Date("2100-01-01T00:00:00Z"),
    });
    await f.db.query("update public.jobs set attempts=1, outcome=$2 where id=$1", [jobId, evidence]);
    let handlerEntered = false;
    const runner = createJobsRunner(
      {
        ...f.store,
        async inspect(job, owner, tx) {
          const state = await f.store.inspect(job, owner, tx);
          if (takeover && state === "reconcile") {
            await f.db.query("update public.jobs set lease_until='-infinity' where id=$1", [jobId]);
            await f.store.claim(kind, successor, 30, 1);
          }
          return state;
        },
      },
      {
        [kind]: {
          concurrency: 1,
          async run() {
            handlerEntered = true;
            return { status: "done" };
          },
        },
      },
      undefined,
      () => () => {},
    );
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(handlerEntered).toBe(false);
    const { rows } = await f.db.query(
      "select state, lease_owner, lease_epoch::int as lease_epoch, outcome from public.jobs where id=$1",
      [jobId],
    );
    expect(rows).toEqual(
      takeover
        ? [{ state: "leased", lease_owner: successor, lease_epoch: 2, outcome: evidence }]
        : [
            {
              state: "failed",
              lease_owner: null,
              lease_epoch: 1,
              outcome: { reason: "extension_budget_exhausted", evidence },
            },
          ],
    );
  },
);

test("Boat extension and stop jobs serialize claims on the same sandbox", async () => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const owner = crypto.randomUUID();
  const options = { orgId: f.people.org, maxAttempts: 3, deadline: new Date("2100-01-01T00:00:00Z") };
  const extend = await f.store.enqueue("boat_runtime_extend", id, 2, `${id}:extend`, null, options);
  const stop = await f.store.enqueue("stop", id, 2, `${id}:stop`, null, options);

  const extensionLease = (await f.store.claim("boat_runtime_extend", owner, 30, 1))!;
  expect(extensionLease.id).toBe(extend);
  expect(await f.store.claim("stop", owner, 30, 1)).toBeUndefined();
  expect(await f.store.complete(extensionLease, owner, { status: "retry", after: new Date(0) })).toBe(true);

  const stopLease = await f.store.claim("stop", owner, 30, 1);
  expect(stopLease?.id).toBe(stop);
  expect(await f.store.claim("boat_runtime_extend", owner, 30, 1)).toBeUndefined();
});

test.each(["activity", "reconcile"] as const)("a live %s lease defers a Boat extension claim", async (legacy) => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const kind = "boat_runtime_extend";
  const owner = crypto.randomUUID();
  const extend = await f.store.enqueue(kind, id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
  });
  const [lease, deadline] =
    legacy === "activity" ? ["activity_lease_id", "activity_until"] : ["reconcile_lease", "reconcile_lease_until"];
  await f.db.query(`update sandboxes set ${lease}=$2, ${deadline}='infinity' where id=$1`, [id, owner]);

  expect(await f.store.claim(kind, owner, 30, 1)).toBeUndefined();

  await f.db.query(`update sandboxes set ${deadline}='-infinity' where id=$1`, [id]);
  expect((await f.store.claim(kind, owner, 30, 1))?.id).toBe(extend);
});

test.each(["activity", "reconcile"] as const)("a live Boat extension excludes a legacy %s claim", async (legacy) => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const owner = crypto.randomUUID();
  const kind = "boat_runtime_extend";
  const jobId = await f.store.enqueue(kind, id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
  });
  expect((await f.store.claim(kind, owner, 30, 1))?.id).toBe(jobId);

  const [lease, deadline] =
    legacy === "activity" ? ["activity_lease_id", "activity_until"] : ["reconcile_lease", "reconcile_lease_until"];
  const claimLegacy = () =>
    f.db.query(`update sandboxes set ${lease}=$2, ${deadline}='infinity' where id=$1 returning id`, [
      id,
      crypto.randomUUID(),
    ]);
  expect((await claimLegacy()).rows).toEqual([]);

  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  expect((await claimLegacy()).rows).toEqual([{ id }]);
});

test("a replacement launch claimant reads Modal create intent and fences the previous writer", async () => {
  const f = await fixture();
  const id = await sandbox(f);
  const encryptionKey = btoa("\0".repeat(32));
  const jobId = await f.store.enqueue("launch", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  const owner = crypto.randomUUID();
  const first = (await f.store.claim("launch", owner, 30, 1))!;
  const journal = f.store.modalLaunchJournal(first);
  const intent = { operation: "create", phase: "creating", revision: 1, intent: "fixture" } as const;
  const receipt = { ...intent, phase: "allocated", revision: 2, machineId: "machine" } as const;
  expect(await journal.read("machine-key")).toBeUndefined();
  expect(await journal.compareAndSet("machine-key", undefined, intent)).toBe(true);
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);

  const restarted = createJobsStore(f.sql, encryptionKey);
  const successorOwner = crypto.randomUUID();
  const successor = (await restarted.claim("launch", successorOwner, 30, 1))!;
  const resumed = restarted.modalLaunchJournal(successor);
  expect(await resumed.read("machine-key")).toEqual(intent);
  await expect(journal.read("machine-key")).rejects.toThrow("claim is no longer current");
  expect(await journal.compareAndSet("machine-key", 1, receipt)).toBe(false);
  expect(await resumed.compareAndSet("different-key", 1, receipt)).toBe(false);
  expect(await resumed.compareAndSet("machine-key", 1, receipt)).toBe(true);
  expect(await resumed.compareAndSet("machine-key", 1, { ...receipt, machineId: "other" })).toBe(false);
  expect(
    await restarted.complete(successor, successorOwner, {
      status: "retry",
      after: new Date(0),
      outcome: { reason: "waiting_for_enrolment" },
    }),
  ).toBe(true);
  const retried = restarted.modalLaunchJournal((await restarted.claim("launch", crypto.randomUUID(), 30, 1))!);
  expect(await retried.read("machine-key")).toEqual(receipt);
  await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [id]);
  await expect(retried.read("machine-key")).rejects.toThrow("claim is no longer current");
  expect(await retried.compareAndSet("machine-key", 2, { ...receipt, revision: 3 })).toBe(false);
});

async function unboundModalSandbox(f: Awaited<ReturnType<typeof fixture>>, providerSandboxId: string | null = null) {
  const goldenId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into goldens (id, org_id, owner_id, name, visibility, provider, modal_workspace, modal_environment, modal_app_id)
     values ($1, $2, $3, 'modal-launch', 'private', 'modal', 'workspace', 'main', 'ap-test')`,
    [goldenId, f.people.org, f.people.owner],
  );
  await f.db.query(
    `insert into sandboxes (id, golden_id, org_id, owner_id, harness, provider, status, lifecycle_generation, runtime_transport, provider_sandbox_id)
     values ($1, $2, $3, $4, 'codex', 'modal', 'starting', 2, 'dialout',$5)`,
    [id, goldenId, f.people.org, f.people.owner, providerSandboxId],
  );
  return id;
}

const launchEncryptionKey = btoa("\0".repeat(32));

const workspaceConfig = {
  repos: [{ url: "https://github.com/example/workspace", dir: "workspace", branch: "main" }],
  init: ["printf initialized"],
};

async function modalAdmissionFixture(visibility: "org" | "private" = "private", statements?: string[]) {
  const f = await fixture(statements);
  const goldenId = crypto.randomUUID();
  await f.db.query(
    `insert into goldens
       (id, org_id, owner_id, name, visibility, provider, modal_workspace, modal_environment, modal_app_id, provider_snapshot_id, config)
     values ($1,$2,$3,'modal-admission',$5,'modal','workspace','main','ap-test','snapshot',$4)`,
    [goldenId, f.people.org, f.people.owner, workspaceConfig, visibility],
  );
  const scope = scopeKey({
    orgId: f.people.org,
    userId: f.people.owner,
    visibility,
    binding: { workspace: "workspace", environment: "main", appId: "ap-test" },
  });
  await f.db.query(
    `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
     values($1,$2,$3,$4,'builder','builder','{}')`,
    [scope, f.people.org, f.people.owner, visibility],
  );
  await f.db.query(
    `insert into modal_images(scope,name,source_id,record)
     values($1,'snapshot','builder','{"info":{"status":"ready"},"imageId":"im-snapshot"}')`,
    [scope],
  );
  const input: ModalLaunchAdmission = {
    orgId: f.people.org,
    ownerId: f.people.owner,
    request: { key: "launch-key", payload: "launch-digest" },
    sandbox: {
      goldenId,
      harness: "codex",
      model: "gpt-5",
      reasoningEffort: "medium",
      effectiveTtlSeconds: 1800,
      machineSize: {
        version: 1,
        requested: null,
        effective: null,
        source: "legacy",
        repositoryDir: null,
        capacity: null,
      },
    },
    allocation: { source: { kind: "snapshot", ref: "snapshot" }, computeTtlSeconds: 3600 },
    initialPrompt: "initial instructions",
    deadline: new Date("2100-01-01T00:00:00Z"),
    maxAttempts: 3,
  };
  return { ...f, input };
}

test.each(["lost reply", "refusal", "bootstrap failure", "enrolled failure", "completed failure"] as const)(
  "Boat successor after %s",
  async (outcome) => {
    const { db, sql, input, people } = await modalAdmissionFixture();
    const golden = (
      await db.query<{ id: string; provider_snapshot_id: string }>(
        "select id,provider_snapshot_id from goldens where owner_id=$1 and provider='boat'",
        [people.owner],
      )
    ).rows[0]!;
    const account = (
      await db.query<{ id: string; version: number }>(
        "select id,version from credentials where owner_id=$1 and kind='claude_oauth'",
        [people.owner],
      )
    ).rows[0]!;
    const {
      sandbox: { id: sandboxId },
    } = await admitModalLaunch(sql, ENCRYPTION_KEY, {
      ...input,
      boat: { scope: "user", backendId: "account" },
      sandbox: {
        ...input.sandbox,
        goldenId: golden.id,
        credentialId: account.id,
        credentialVersion: account.version,
        harness: "claude",
        model: "claude-sonnet-4-6",
      },
      allocation: { ...input.allocation, source: { kind: "snapshot", ref: golden.provider_snapshot_id } },
    });
    const jobs = createJobsStore(sql, ENCRYPTION_KEY);
    const enrolments = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const { key, scope } = await resolveBoatKey(createSqlVaultStore(sql), ENCRYPTION_KEY, {
      userId: people.owner,
      orgId: people.org,
      visibility: "private",
    });
    const boatKeyDigest = await sha256Hex(JSON.stringify([scope, key]));
    const machine = { sandboxId, generation: 1, machineId: "boat-worker" };
    const unsupported = async () => {
      throw Error("Unexpected lifecycle operation");
    };
    const context = { signal: new AbortController().signal, canDispatch: async () => true };
    let allocations = 0;
    let delayedTicket: string | undefined;
    async function run() {
      const owner = crypto.randomUUID();
      const job = (await jobs.claim("launch", owner, 30, 1))!;
      const plan = () => ({
        boat: boatKeyDigest,
        bindingRef: job.id,
        allocation: { ...input.allocation, size: null },
        canUseModalCredential: async () => true,
        prepareRuntimeTicket: async () => ({
          ownerId: people.owner,
          configuration: { grant: { expiresAt: 1 } },
          serverUrl: "https://armada.test",
          artifact: { sha256: "", bytes: 1 },
          cacheDir: "/fixture",
          lockPrerequisites: async () => {},
          accountPin: { credentialId: account.id, credentialVersion: account.version },
        }),
        machine: (ticket: (request: typeof machine, expiry: number) => Promise<{ enrolmentToken: string } | null>) => ({
          async create() {
            allocations++;
            if (outcome === "refusal")
              throw new ProviderError({
                provider: "boat",
                status: 402,
                code: "payment_required",
                retryable: false,
                message: "Fixture",
              });
            throw Error("Lost Boat create reply.");
          },
          async observe() {
            return allocations
              ? ({ kind: "present", machine, phase: "running", receipt: { operation: "create", machine } } as const)
              : ({ kind: "absent" } as const);
          },
          async bootstrap(request: typeof machine) {
            const lifecycle = createSandboxLifecycle(sql, unsupported);
            expect(await lifecycle.reconcileOne(new AbortController().signal)).toBe(false);
            const configuration = await ticket(request, Date.now() + 3_600_000);
            delayedTicket = configuration?.enrolmentToken;
          },
          resume: unsupported,
          stop: unsupported,
          delete: unsupported,
        }),
      });
      await jobs.complete(job, owner, await runModalLaunch(sql, ENCRYPTION_KEY, job, context, plan, "boat"));
    }
    const vacate = () =>
      db.query(
        "update jobs set lease_until=clock_timestamp()-interval '1 second' where sandbox_id=$1 and kind='launch'",
        [sandboxId],
      );
    if (outcome === "refusal") {
      expect(await jobs.claim("launch", crypto.randomUUID(), 30, 1)).toBeDefined();
      await vacate();
      await run();
      expect((await db.query("select status from sandboxes where id=$1", [sandboxId])).rows).toEqual([
        { status: "failed" },
      ]);
      return;
    }
    await expect(run()).rejects.toThrow("Lost Boat create reply.");
    await vacate();
    await run();
    if (!delayedTicket) throw Error("Boat bootstrap did not receive a ticket.");
    if (outcome === "bootstrap failure") {
      expect(await requestBoatLaunchFailure(sql, sandboxId, "1")).toBe(true);
      await db.query("update jobs set run_after=now() where sandbox_id=$1 and kind='launch'", [sandboxId]);
      await run();
      expect((await db.query("select kind from jobs where sandbox_id=$1 and kind='delete'", [sandboxId])).rows).toEqual(
        [{ kind: "delete" }],
      );
      const data = createSqlData(sql)({
        userId: people.owner,
        orgs: [{ orgId: people.org, role: "member" }],
        via: "service",
      });
      await expect(data.sandboxes.assertDeletionAllowed!(sandboxId)).rejects.toThrow("exit is unconfirmed");
      return;
    }
    await db.query("update credentials set expires_at=now() where id=$1", [account.id]);
    await expect(enrolments.enrol(delayedTicket)).rejects.toThrow("runtime_enrolment_denied");
    await db.query("update credentials set expires_at=null where id=$1", [account.id]);
    const session = await enrolments.enrol(delayedTicket);
    if (outcome === "enrolled failure" || outcome === "completed failure") {
      await db.query("update jobs set run_after=now() where sandbox_id=$1 and kind='launch'", [sandboxId]);
      if (outcome === "completed failure") await run();
      const request = new Request("https://armada.test/api/runtime/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch },
        body: JSON.stringify({ stage: "runtime_failed" }),
      });
      const report = await createRuntimeProgress(enrolments, ENCRYPTION_KEY)(request);
      expect(report?.status).toBe(200);
      const owner = crypto.randomUUID();
      const cleanup = (await jobs.claim("delete", owner, 30, 1))!;
      let stops = 0;
      const result = await runFailedModalLaunchDelete(sql, cleanup, context, undefined, async (authorize) => ({
        create: unsupported,
        resume: unsupported,
        stop: unsupported,
        bootstrap: unsupported,
        observe: async () => ({ kind: "present", machine, phase: "running" }),
        async delete(target) {
          await authorize();
          expect(target).toMatchObject({ ...machine, scope: "physical-only" });
          stops++;
        },
      }));
      await jobs.complete(cleanup, owner, result);
      expect((await db.query("select stopped_at from sandboxes where id=$1", [sandboxId])).rows).toEqual([
        { stopped_at: expect.anything() },
      ]);
      expect(stops).toBe(1);
      return;
    }
    expect((await db.query("select status,provider_sandbox_id from sandboxes where id=$1", [sandboxId])).rows).toEqual([
      { status: "ready", provider_sandbox_id: machine.machineId },
    ]);
    expect(allocations).toBe(1);
  },
);

test("Modal backfill preserves accepted, refused and unresolved ordinary keys without scheduling work", async () => {
  const { db, sql, input, store } = await modalAdmissionFixture();
  const { request: _request, ...unkeyed } = input;
  const accepted = (await admitModalLaunch(sql, launchEncryptionKey, unkeyed)).sandbox.id;
  await db.query("delete from jobs where sandbox_id=$1", [accepted]);

  const key = 'historical-launch-"\\雪\n';
  const payload = { surface: "control", route: "modal-runtime", request: { prompt: null, repo: "workspace" } };
  const refusalKey = `${key}refused`;
  const fingerprint = ordinaryLaunchFingerprint(payload);
  expect(fingerprint).toBe("58fd07ec69fc5341b486d99ee4011e65f3ea41ed7e3fbb787ad66dc579952b21");
  await db.query(
    `insert into ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint, authority, failure)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      crypto.randomUUID(),
      input.orgId,
      input.ownerId,
      refusalKey,
      fingerprint,
      { target: { provider: "modal" } },
      { kind: "golden", code: "setup_failed" },
    ],
  );

  const requests = [
    { key: `${key}accepted\ud800`, payload: "historical-accepted", id: accepted },
    { key: `${key}unknown`, payload: "historical-unknown", id: crypto.randomUUID() },
    { key: `${key}unattributed`, payload: "historical-unattributed", id: crypto.randomUUID() },
    { key: `${key}boat`, payload: "historical-boat", id: crypto.randomUUID() },
  ] as const;
  const [success, unknown, unattributed, boat] = requests;
  for (const request of requests) {
    await db.query(
      `insert into ordinary_launch_receipts
        (id, org_id, owner_id, request_key, fingerprint, authority, response)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        request.id,
        input.orgId,
        input.ownerId,
        request === success ? `${key}accepted\ufffd` : request.key,
        new Bun.CryptoHasher("sha256").update(JSON.stringify(request.payload)).digest("hex"),
        request === unattributed ? null : { target: { provider: request === boat ? "boat" : "modal" } },
        request === success ? { sandbox: { id: accepted, status: "ready" }, promptId: "prior-prompt" } : null,
      ],
    );
  }

  for (let replay = 0; replay < 2; replay++) {
    const { rows } = await db.query("select backfill_modal_launch_receipts()::int as verified");
    expect(rows).toEqual([{ verified: requests.length + 1 }]);
  }
  const admit = ({ key, payload }: { key: string; payload: unknown }) =>
    admitModalLaunch(sql, launchEncryptionKey, { ...input, request: { key, payload } });
  await expect(
    admit({
      key: refusalKey,
      payload: {
        request: { repo: "workspace", prompt: null, size: undefined },
        route: payload.route,
        surface: payload.surface,
      },
    }),
  ).rejects.toMatchObject({ code: "setup_failed" });
  await expect(
    admit({
      key: refusalKey,
      payload: { ...payload, request: { repo: "workspace" } },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await admit(success)).toEqual({ sandbox: { id: accepted, status: "starting" } });
  for (const receipt of [unknown, unattributed, boat]) {
    await expect(admit(receipt)).rejects.toMatchObject({ code: "outcome_unknown" });
  }
  expect(await store.claim("launch", crypto.randomUUID(), 30, 1)).toBeUndefined();
  expect((await db.query("select id from sandboxes")).rows).toEqual([{ id: accepted }]);

  const caller = {
    via: "service" as const,
    userId: input.ownerId,
    orgs: [{ orgId: input.orgId, role: "member" as const }],
  };
  const { sandboxes } = createSqlData(sql)(caller);
  const sandbox = (await sandboxes.get(accepted))!;
  expect(await sandboxes.requestStartingModalStop!(sandbox)).toBeNull();
  expect(await createModalJobReader(sql, launchEncryptionKey)(sandbox, caller)).toBeNull();
});

test("Modal backfill refuses unresolved predecessor allocations before archiving ordinary keys", async () => {
  const { db, input } = await modalAdmissionFixture();
  const { orgId, ownerId } = input;
  const backfill = () =>
    db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return tx.query("select public.backfill_modal_launch_receipts()::int as verified");
    });
  await db.query(
    `insert into ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint)
     values ($1,$2,$3,'historical-cutover-launch-key','historical-digest')`,
    [crypto.randomUUID(), orgId, ownerId],
  );
  const { rows: reservations } = await db.query<{ id: string; client_key: string }>(
    `with template as (
       insert into launch_templates(org_id,owner_id,scope,name)
       values($1,$2,'personal','pending-cutover') returning id
     ), revision as (
       insert into launch_template_revisions(template_id,revision,definition,digest,created_by)
       select id,1,'{}',repeat('a',64),$2 from template returning id,template_id
     )
     insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,manifest,sandbox_id)
     select $1,$2,source.provider,repeat('a',64),template_id,id,
       jsonb_build_object('golden',jsonb_build_object('provider',source.provider)),gen_random_uuid()
     from revision cross join (values ('modal'), ('boat')) as source(provider)
     returning id,client_key`,
    [orgId, ownerId],
  );
  const modal = reservations.find((row) => row.client_key === "modal")!;
  for (const [index, state] of ["claimed", "allocating", "reconciling"].entries()) {
    if (index) await db.query("update template_launch_requests set state=$2 where id=$1", [modal.id, state]);
    await expect(backfill()).rejects.toThrow("unresolved Modal predecessor work");
  }
  await db.query("update template_launch_requests set state='failed' where id=$1", [modal.id]);

  const {
    rows: [boatGolden],
  } = await db.query<{ id: string }>("select id from goldens where owner_id=$1 and provider='boat'", [ownerId]);
  await db.query(
    `insert into ordinary_launch_snapshot_intents (sandbox_id,golden_id,provider,snapshot_id)
     values ($1,$2,'modal','snapshot'), ($3,$4,'boat','boat-snapshot')`,
    [crypto.randomUUID(), input.sandbox.goldenId, crypto.randomUUID(), boatGolden!.id],
  );
  await expect(backfill()).rejects.toThrow("unresolved Modal predecessor work");
  expect((await db.query("select id from jobs")).rows).toEqual([]);
  await db.query("delete from ordinary_launch_snapshot_intents where provider='modal'");
  expect((await backfill()).rows).toEqual([{ verified: 1 }]);
});

test("Modal backfill refuses fixed transaction snapshots", async () => {
  const { db } = await fixture();
  await expect(
    db.transaction(async (tx) => {
      await tx.exec("set transaction isolation level repeatable read");
      return tx.query("select public.backfill_modal_launch_receipts()");
    }),
  ).rejects.toThrow("Modal receipt backfill requires read committed isolation");
});

test("Modal backfill rolls back when a destination key belongs to a different receipt", async () => {
  const { db, sql, input } = await modalAdmissionFixture();
  await admitModalLaunch(sql, launchEncryptionKey, {
    ...input,
    request: { key: "colliding-launch-key", payload: "new-digest" },
  });
  await db.query(
    `insert into ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint)
     values ($1,$3,$4,'another-historical-key','old-digest'), ($2,$3,$4,'colliding-launch-key',$5)`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      input.orgId,
      input.ownerId,
      new Bun.CryptoHasher("sha256").update(JSON.stringify("new-digest")).digest("hex"),
    ],
  );
  await expect(db.query("select backfill_modal_launch_receipts()")).rejects.toThrow(
    "Modal launch receipt backfill conflicts",
  );
  expect((await db.query("select count(*)::int as count from jobs where kind='launch'")).rows).toEqual([{ count: 1 }]);
});

test.each(["receipt", "job"] as const)(
  "an ordinary launch %s reserves the shared key during deploy overlap",
  async (first) => {
    const { db, input, sql } = await modalAdmissionFixture();
    const key = "overlap-launch-key";
    const payload = { golden: "boat-golden" };
    const predecessor = () =>
      db.query(
        `insert into ordinary_launch_receipts (id,org_id,owner_id,request_key,fingerprint,authority)
       values ($1,$2,$3,$4,$5,$6)`,
        [
          crypto.randomUUID(),
          input.orgId,
          input.ownerId,
          key,
          ordinaryLaunchFingerprint(payload),
          { target: { provider: "boat" } },
        ],
      );
    const current = () => admitModalLaunch(sql, launchEncryptionKey, { ...input, request: { key, payload } });

    if (first === "receipt") {
      await predecessor();
      await expect(current()).rejects.toMatchObject({ code: "outcome_unknown" });
      expect((await db.query("select id from sandboxes")).rows).toEqual([]);
    } else {
      const { sandbox } = await current();
      await expect(predecessor()).rejects.toMatchObject({ code: "A2760" });
      expect((await db.query("select id from ordinary_launch_receipts")).rows).toEqual([]);
      expect((await db.query("select id from sandboxes")).rows).toEqual([{ id: sandbox.id }]);
    }
  },
);

function admitModalLaunch(sql: Sql, key: string, input: ModalLaunchAdmission) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
  const mcp = createRuntimeMcp({ sql, key, origin: "https://armada.example", commands });
  return admitModalLaunchWithMcp(sql, key, input, mcp);
}

test.each([
  { limits: { "gpt-5": 1 }, max: null, message: "Model gpt-5" },
  { limits: {}, max: 1, message: "1/1 agents working" },
])("Modal starting admissions count against the account cap ($message)", async ({ limits, max, message }) => {
  const { db, sql, input, openaiCredentialId } = await modalAdmissionFixture();
  await db.query("update credentials set max_agents=$2,model_limits=$3 where id=$1", [openaiCredentialId, max, limits]);
  const bound = { ...input, sandbox: { ...input.sandbox, credentialId: openaiCredentialId, credentialVersion: 1 } };
  const admitted = await admitModalLaunch(sql, launchEncryptionKey, bound);
  await expect(
    admitModalLaunch(sql, launchEncryptionKey, { ...bound, request: { key: "another-launch", payload: "another" } }),
  ).rejects.toThrow(message);
  expect(await admitModalLaunch(sql, launchEncryptionKey, bound)).toEqual(admitted);
  expect((await db.query("select sandbox_id from jobs where kind='launch'")).rows).toEqual([
    { sandbox_id: admitted.sandbox.id },
  ]);
  expect((await db.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
});

test("two Modal pool launches at cap minus one bind different accounts", async () => {
  const { db, sql, input } = await modalAdmissionFixture();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await db.query(
    `insert into credentials(id,scope,owner_id,kind,name,value_enc,max_agents)
     values($1,'user',$3,'openai','first',$4,2),($2,'user',$3,'openai','second',$4,1)`,
    [first, second, input.ownerId, await encryptSecret("offline-pool-account", launchEncryptionKey)],
  );
  const sandbox = { ...input.sandbox, credentialId: first, credentialVersion: 1 };
  await admitModalLaunch(sql, launchEncryptionKey, { ...input, sandbox });
  const accountPool = {
    pool: { harness: "codex" as const, credentialIds: [first, second], model: sandbox.model },
    prepared: new Map(
      [first, second].map((id) => [
        id,
        {
          model: sandbox.model,
          reasoningEffort: sandbox.reasoningEffort,
          credentialVersion: 1,
        },
      ]),
    ),
  };
  const launch = (key: string) =>
    admitModalLaunch(sql, launchEncryptionKey, {
      ...input,
      sandbox,
      accountPool,
      request: { key, payload: key },
    });
  const receipts = await Promise.all([launch("pool-first"), launch("pool-second")]);
  const { rows } = await db.query(
    `select s.credential_id,s.model
     from unnest($1::uuid[]) with ordinality requested(id,position) join sandboxes s on s.id=requested.id
     order by requested.position`,
    [receipts.map(({ sandbox }) => sandbox.id)],
  );
  expect(rows).toEqual([
    { credential_id: first, model: sandbox.model },
    { credential_id: second, model: sandbox.model },
  ]);
});

test("Modal admission refuses a fresh launch on an exhausted bound account", async () => {
  const { db, sql, input, openaiCredentialId } = await modalAdmissionFixture();
  await db.query(
    `insert into account_exhaustion(account_id,account_version,code,resets_at,event_at)
     values($1,1,'usage_limit_exceeded','2100-01-01T00:00:00Z',0)`,
    [openaiCredentialId],
  );
  await expect(
    admitModalLaunch(sql, launchEncryptionKey, {
      ...input,
      sandbox: { ...input.sandbox, credentialId: openaiCredentialId, credentialVersion: 1 },
    }),
  ).rejects.toThrow("is exhausted until");
  expect((await db.query("select sandbox_id from jobs where kind='launch'")).rows).toEqual([]);
});

test("Modal scoped admission atomically reserves one private parent across receipt replay", async () => {
  const { db, sql, input, openaiCredentialId, people } = await modalAdmissionFixture("org");
  const scoped = {
    ...input,
    armadaAccess: { maxActiveChildren: 2 },
    sandbox: { ...input.sandbox, credentialId: openaiCredentialId, credentialVersion: 1 },
  };
  const interrupted: Sql = {
    ...sql,
    transaction: (work) =>
      sql.transaction!((tx) =>
        work({
          ...tx,
          query: (statement, params) => {
            if (statement.includes("insert into public.orchestrator_lifecycle"))
              throw new Error("Interrupted scoped parent registration.");
            return tx.query(statement, params);
          },
        }),
      ),
  };
  await expect(admitModalLaunch(interrupted, launchEncryptionKey, scoped)).rejects.toThrow(
    "Interrupted scoped parent registration.",
  );
  expect((await db.query("select id from armada_access_parents where kind='sandbox'")).rows).toEqual([]);
  expect((await db.query("select id from jobs where kind='launch'")).rows).toEqual([]);
  expect((await db.query("select id from sandboxes where golden_id=$1", [input.sandbox.goldenId])).rows).toEqual([]);
  const admitted = await admitModalLaunch(sql, launchEncryptionKey, scoped);
  expect(await admitModalLaunch(sql, launchEncryptionKey, scoped)).toEqual(admitted);
  expect(
    (
      await db.query(
        `select p.golden_ids, p.credential_ids, s.visibility, l.max_active_children
         from armada_access_parents p join sandboxes s on s.id=p.sandbox_id
         join orchestrator_lifecycle l on l.orchestrator_id=p.id
         where p.sandbox_id=$1 and p.org_id=$2 and p.owner_id=$3`,
        [admitted.sandbox.id, people.org, people.owner],
      )
    ).rows,
  ).toEqual([
    {
      golden_ids: [input.sandbox.goldenId],
      credential_ids: [openaiCredentialId],
      visibility: "private",
      max_active_children: 2,
    },
  ]);
});

async function launchConnection(
  db: Awaited<ReturnType<typeof fixture>>["db"],
  people: Awaited<ReturnType<typeof fixture>>["people"],
) {
  const id = crypto.randomUUID();
  await db.query(
    `with definition as (
       insert into mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type,default_for_launch)
       values($1,$2,$3,'personal','launch test','http','https://example.com/mcp','none',true) returning id
     )
     insert into mcp_grants(connection_id,status) select id,'connected' from definition`,
    [id, people.org, people.owner],
  );
  return id;
}

test("ordinary Modal admission freezes defaults and honors explicit opt-out", async () => {
  const { db, sql, people, input } = await modalAdmissionFixture();
  const connectionId = await launchConnection(db, people);
  const admitted = modalLaunchReceipt.parse(await admitModalLaunch(sql, launchEncryptionKey, input));
  await db.query("update mcp_connections set default_for_launch=false where id=$1", [connectionId]);
  const disconnected = await launchConnection(db, people);
  await db.query("update mcp_grants set status='not_connected' where connection_id=$1", [disconnected]);
  expect(await admitModalLaunch(sql, launchEncryptionKey, input)).toEqual(admitted);
  await admitModalLaunch(sql, launchEncryptionKey, {
    ...input,
    request: { key: "no-connections", payload: "explicit-empty" },
    connections: [],
  });
  expect((await db.query("select sandbox_id,connection_id from mcp_bindings")).rows).toEqual([
    { sandbox_id: admitted.sandbox.id, connection_id: connectionId },
  ]);
});

test("Modal admission rolls back and returns a conflict when a selected MCP row is locked", async () => {
  const { db, sql, people, input } = await modalAdmissionFixture();
  await launchConnection(db, people);
  const contended: Sql = {
    ...sql,
    transaction: (work) =>
      sql.transaction!((tx) =>
        work({
          ...tx,
          query: (statement, params) => {
            if (statement.includes("for share of c,g")) {
              if (!statement.includes("nowait")) throw new Error("MCP admission would wait for a row lock");
              throw Object.assign(new Error("MCP row is locked"), { code: "55P03" });
            }
            return tx.query(statement, params);
          },
        }),
      ),
  };
  await expect(admitModalLaunch(contended, launchEncryptionKey, input)).rejects.toMatchObject({ code: "conflict" });
  expect((await db.query("select id from sandboxes")).rows).toEqual([]);
  expect((await db.query("select id from jobs")).rows).toEqual([]);
  expect((await admitModalLaunch(sql, launchEncryptionKey, input)).sandbox.status).toBe("starting");
});

const pinnedAdmissionCases = [
  ["modal", "active secret"],
  ["modal", "revoked secret"],
  ["modal", "changed snapshot"],
  ["modal", "changed connection"],
  ["boat", "active secret"],
  ["boat", "changed builder"],
] as const;

test.each(pinnedAdmissionCases)(
  "pinned %s template admission handles %s inside the receipt transaction before provider dispatch",
  async (provider, status) => {
    const { sql, db, people, input, openaiCredentialId } = await modalAdmissionFixture();
    const boat =
      provider === "boat"
        ? (
            await db.query<{ id: string; provider_snapshot_id: string; provider_sandbox_id: string }>(
              "select id,provider_snapshot_id,provider_sandbox_id from goldens where owner_id=$1 and provider='boat'",
              [people.owner],
            )
          ).rows[0]
        : undefined;
    const goldenId = boat?.id ?? input.sandbox.goldenId;
    const snapshot = boat?.provider_snapshot_id ?? input.allocation.source.ref;
    const sandboxId = crypto.randomUUID();
    const connectionId = await launchConnection(db, people);
    await db.query("update mcp_connections set default_for_launch=false where id=$1", [connectionId]);
    const {
      rows: [actor],
    } = await db.query<{ epoch: number }>("select epoch::int from mcp_actor_epochs where org_id=$1 and user_id=$2", [
      people.org,
      people.owner,
    ]);
    const {
      rows: [secret],
    } = await db.query<{ id: string }>(
      `insert into application_secrets(org_id,owner_id,scope,name,value_enc)
       values($1,$2,'personal','APP_TOKEN',$3) returning id`,
      [people.org, people.owner, await encryptSecret("fixture", launchEncryptionKey)],
    );
    const {
      rows: [receipt],
    } = await db.query<{ id: string }>(
      `with template as (
         insert into launch_templates(org_id,owner_id,scope,name)
         values($1,$2,'personal','pinned-modal') returning id
       ), revision as (
         insert into launch_template_revisions(template_id,revision,definition,digest,created_by)
         select id,1,'{}',repeat('a',64),$2 from template returning id,template_id
       )
       insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,
                                            manifest,golden_operation_fence_id,sandbox_id)
       select $1,$2,'pinned',repeat('a',64),template_id,id,$3,$4,$5 from revision returning id`,
      [
        people.org,
        people.owner,
        {
          version: 1,
          actorId: people.owner,
          actorEpoch: actor?.epoch ?? 0,
          golden: {
            id: goldenId,
            provider,
            providerSnapshotId: snapshot,
            config: workspaceConfig,
            ...(boat
              ? { providerSandboxId: status === "changed builder" ? "stale-builder" : boat.provider_sandbox_id }
              : { modal: { workspace: "workspace", environment: "main", appId: "ap-test" } }),
          },
          account: { id: openaiCredentialId, version: 1 },
          definition: {
            provider,
            harness: input.sandbox.harness,
            model: input.sandbox.model,
            reasoningEffort: input.sandbox.reasoningEffort,
            variables: [],
            secrets: [{ key: "APP_TOKEN", secretId: secret!.id, version: 1 }],
          },
          connections: [{ id: connectionId, version: 1, generation: 1 }],
          resolvedSkills: ["example/tool@1.0.0"],
          variables: {},
        },
        crypto.randomUUID(),
        sandboxId,
      ],
    );
    const { request: _ordinary, ...launch } = input;
    const pinned = {
      ...launch,
      templateReceiptId: receipt!.id,
      sandbox: { ...input.sandbox, goldenId, credentialId: openaiCredentialId, credentialVersion: 1 },
      allocation: { ...input.allocation, source: { kind: "snapshot" as const, ref: snapshot } },
      ...(boat ? { boat: { scope: "user" as const, backendId: "fake-boat-account" } } : {}),
    };
    const admit = () => admitModalLaunch(sql, launchEncryptionKey, pinned);
    if (status !== "active secret") {
      if (status === "revoked secret") {
        await db.query("update application_secrets set status='revoked',value_enc=null where id=$1", [secret!.id]);
        await expect(admit()).rejects.toMatchObject({ code: "conflict", reason: "secret_unavailable" });
      } else if (status === "changed connection") {
        await db.query("update mcp_grants set version=version+1 where connection_id=$1", [connectionId]);
        await expect(admit()).rejects.toMatchObject({ code: "conflict" });
      } else if (status === "changed builder") {
        await expect(admit()).rejects.toMatchObject({ code: "conflict" });
      } else {
        await db.query("update goldens set provider_snapshot_id='replacement' where id=$1", [pinned.sandbox.goldenId]);
        await db.query(
          `insert into modal_images(scope,name,source_id,record)
             select scope,'replacement',source_id,record from modal_images where name='snapshot'`,
        );
        pinned.allocation = { ...pinned.allocation, source: { kind: "snapshot", ref: "replacement" } };
        await expect(admit()).rejects.toThrow("Frozen template snapshot or provider binding changed.");
      }
      expect((await db.query("select id from sandboxes where id=$1", [sandboxId])).rows).toEqual([]);
      expect((await db.query("select id from jobs where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
      return;
    }
    const accepted = { sandbox: { id: sandboxId, status: "starting" } } as const;
    const receiptState = async () =>
      (
        await db.query<{ state: string; result: { envelope: unknown } | null }>(
          "select state,result from template_launch_requests where id=$1",
          [receipt!.id],
        )
      ).rows[0];
    const interrupted: Sql = {
      ...sql,
      transaction: (work) =>
        sql.transaction!(async (tx) => {
          await work(tx);
          throw new Error("Admission interrupted before commit");
        }),
    };
    await expect(admitModalLaunch(interrupted, launchEncryptionKey, pinned)).rejects.toThrow(
      "Admission interrupted before commit",
    );
    expect(await receiptState()).toEqual({ state: "claimed", result: null });
    expect((await db.query("select id from sandboxes where id=$1", [sandboxId])).rows).toEqual([]);
    expect((await db.query("select id from jobs where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
    expect(await admit()).toEqual(accepted);
    const published = await receiptState();
    expect(published).toMatchObject({
      state: "succeeded",
      result: {
        requestId: receipt!.id,
        state: "succeeded",
        id: sandboxId,
        status: "starting",
        provider,
        manifest: { resolvedSkills: ["example/tool@1.0.0"] },
      },
    });
    expect(published?.result?.envelope).toEqual(accepted);
    expect(await admit()).toEqual(accepted);
    expect(await receiptState()).toEqual(published);
    expect(
      await createJobsStore(sql, launchEncryptionKey).claim(MODAL_INITIAL_TURN, crypto.randomUUID(), 30, 1),
    ).toBeUndefined();
    const {
      rows: [setupRow],
    } = await db.query<{ payload_enc: Uint8Array<ArrayBuffer> }>(
      "select payload_enc from jobs where sandbox_id=$1 and kind=$2",
      [sandboxId, MODAL_INITIAL_TURN],
    );
    expect(JSON.parse(await decryptSecret(setupRow!.payload_enc, launchEncryptionKey))).toMatchObject({
      skills: ["example/tool@1.0.0"],
    });
    expect((await db.query("select sandbox_id,connection_id from mcp_bindings")).rows).toEqual([
      { sandbox_id: sandboxId, connection_id: connectionId },
    ]);
    expect(
      (
        await db.query(
          `select s.application_secret_tainted,s.provider_sandbox_id,r.id as receipt_id
       from sandboxes s join template_launch_requests r on r.sandbox_id=s.id`,
        )
      ).rows,
    ).toEqual([{ application_secret_tainted: true, provider_sandbox_id: null, receipt_id: receipt!.id }]);
    expect((await db.query("select kind from jobs where sandbox_id=$1 order by kind", [sandboxId])).rows).toEqual([
      { kind: "launch" },
      { kind: MODAL_INITIAL_TURN },
    ]);
  },
);

test("Modal admission commits an unbound sandbox, scoped job and encrypted turn intent before a claim", async () => {
  const { sql, db, input, store } = await modalAdmissionFixture();
  const machineSize = {
    version: 1,
    requested: null,
    effective: "small",
    source: "repository",
    repositoryDir: "workspace",
    capacity: {
      provider: "modal",
      provenance: "requested-provider-resources",
      vcpus: 2,
      memoryMiB: 4096,
      cpuPhysicalCores: 1,
      cpuLimitPhysicalCores: 1,
      memoryLimitMiB: 4096,
      boatType: null,
    },
  } as const;
  const resourceProject = { version: 1, ...workspaceConfig.repos[0]! } as const;
  input.sandbox = { ...input.sandbox, repositoryDir: "workspace", machineSize, resourceProject };
  const { sandbox } = await admitModalLaunch(sql, launchEncryptionKey, input);
  expect(sandbox).toEqual({ id: expect.any(String), status: "starting" });
  expect(
    (
      await db.query(
        `select s.provider_sandbox_id, s.lifecycle_generation::text as generation, s.status, p.snapshot_id, s.machine_size, s.resource_project,
              s.effective_ttl_seconds, extract(epoch from (s.expires_at-s.created_at))::int as expiry_seconds
       from sandboxes s join sandbox_source_snapshots p on p.sandbox_id=s.id where s.id=$1`,
        [sandbox.id],
      )
    ).rows,
  ).toEqual([
    {
      provider_sandbox_id: null,
      generation: "1",
      status: "starting",
      snapshot_id: "snapshot",
      machine_size: machineSize,
      resource_project: resourceProject,
      effective_ttl_seconds: 1800,
      expiry_seconds: 1800,
    },
  ]);
  const job = await store.claim("launch", crypto.randomUUID(), 30, 1);
  expect(job).toMatchObject({
    sandbox_id: sandbox.id,
    generation: "1",
    payload: {
      allocation: { ...input.allocation, size: "small", source: { kind: "snapshot", ref: "im-snapshot" } },
      snapshot: "snapshot",
      modal: { workspace: "workspace", environment: "main", appId: "ap-test" },
    },
  });
  const {
    rows: [turn],
  } = await db.query<{ payload_enc: Uint8Array<ArrayBuffer> }>(
    `select payload_enc from jobs
     where sandbox_id=$1 and generation=1 and kind='launch_initial_turn' and state='queued'`,
    [sandbox.id],
  );
  expect(JSON.parse(await decryptSecret(turn!.payload_enc, launchEncryptionKey))).toEqual({
    launchJobId: job!.id,
    prompt: input.initialPrompt,
    workspace: workspaceConfig,
    skills: [],
  });
});

test("a stale Modal snapshot cannot leave a launch receipt behind", async () => {
  const { sql, db, input } = await modalAdmissionFixture();
  await db.query("update goldens set provider_snapshot_id='replacement' where id=$1", [input.sandbox.goldenId]);
  await expect(admitModalLaunch(sql, launchEncryptionKey, input)).rejects.toMatchObject({ code: "conflict" });
  expect((await db.query("select id from jobs")).rows).toEqual([]);
  expect((await db.query("select id from sandboxes where golden_id=$1", [input.sandbox.goldenId])).rows).toEqual([]);
});

test("Modal keyed replay returns the current status and refuses a changed request", async () => {
  const { sql, db, input } = await modalAdmissionFixture();
  const { sandbox } = await admitModalLaunch(sql, launchEncryptionKey, input);
  await db.query("update sandboxes set status='failed' where id=$1", [sandbox.id]);
  expect(await admitModalLaunch(sql, launchEncryptionKey, input)).toEqual({
    sandbox: { id: sandbox.id, status: "failed" },
  });
  await expect(
    admitModalLaunch(sql, launchEncryptionKey, {
      ...input,
      request: { key: input.request!.key, payload: "different" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await db.query("select kind from jobs order by kind")).rows).toEqual([
    { kind: "launch" },
    { kind: "launch_initial_turn" },
  ]);
});

test("Modal keyed replay checks current authorization after membership revocation", async () => {
  const { sql, db, input } = await modalAdmissionFixture();
  await admitModalLaunch(sql, launchEncryptionKey, input);
  await db.query("delete from members where org_id=$1 and user_id=$2", [input.orgId, input.ownerId]);
  await expect(admitModalLaunch(sql, launchEncryptionKey, input)).rejects.toMatchObject({ code: "not_found" });
});

test("an interrupted Modal admission rolls back the sandbox and both jobs without a wake", async () => {
  const { sql, db, input } = await modalAdmissionFixture();
  const interrupted: Sql = {
    ...sql,
    transaction: (work) =>
      sql.transaction!(async (tx) => {
        await work(tx);
        throw new Error("interrupted before commit");
      }),
  };
  let wakes = 0;
  const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, () => wakes++);
  try {
    await expect(admitModalLaunch(interrupted, launchEncryptionKey, input)).rejects.toThrow(
      "interrupted before commit",
    );
    expect((await db.query("select id from sandboxes where golden_id=$1", [input.sandbox.goldenId])).rows).toEqual([]);
    expect((await db.query("select id from jobs")).rows).toEqual([]);
    expect(wakes).toBe(0);
    await admitModalLaunch(sql, launchEncryptionKey, input);
    expect(wakes).toBe(1);
  } finally {
    unsubscribe();
  }
});

test("an unbound Modal launch can publish only its leased allocation receipt", async () => {
  const f = await fixture();
  const id = await unboundModalSandbox(f);
  const bind = (tx: Sql, machineId: string) =>
    tx.query("update sandboxes set provider_sandbox_id=$2 where id=$1 returning provider_sandbox_id", [id, machineId]);
  await expect(bind(f.sql, "guessed")).rejects.toMatchObject({ code: "23514" });
  await expect(f.sql.query("update sandboxes set status='ready' where id=$1", [id])).rejects.toMatchObject({
    code: "23514",
  });

  const jobId = await f.store.enqueue("launch", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  const original = (await f.store.claim("launch", crypto.randomUUID(), 30, 1))!;
  expect(
    await f.store.modalLaunchJournal(original).compareAndSet("machine-key", undefined, {
      operation: "create",
      phase: "allocated",
      intent: "fixture",
      revision: 1,
      machineId: "allocated",
    }),
  ).toBe(true);
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  await expect(bind(f.sql, "allocated")).rejects.toMatchObject({ code: "23514" });

  const successor = (await f.store.claim("launch", crypto.randomUUID(), 30, 1))!;
  expect(await withJobLease(f.sql, original, (tx) => bind(tx, "allocated"))).toBeUndefined();
  await expect(withJobLease(f.sql, successor, (tx) => bind(tx, "guessed"))).rejects.toMatchObject({ code: "23514" });
  const result = await withJobLease(f.sql, successor, (tx) => bind(tx, "allocated"));
  expect(result?.rows).toEqual([{ provider_sandbox_id: "allocated" }]);
  await expect(withJobLease(f.sql, successor, (tx) => bind(tx, "guessed"))).rejects.toMatchObject({ code: "23514" });
});

type ModalLaunchStep =
  | "open Modal"
  | "dispatch credential"
  | "create response"
  | "bootstrap dispatch"
  | "bootstrap response"
  | "image lookup"
  | "runtime ticket"
  | "baseline capture response"
  | "exact machine ownership"
  | "termination response"
  | "machine poll"
  | "cleanup preparation";

function modalTestArtifactManifest(digit: string) {
  return {
    protocol: 1,
    platform: "linux",
    libc: "glibc",
    architecture: "x64",
    runtime: { sha256: digit.repeat(64), bytes: 1 },
    harnesses: { codex: { archive: { sha256: digit.repeat(63) + "0", bytes: 2 } } },
  };
}

async function modalLaunchFixture(initial?: Awaited<ReturnType<typeof modalAdmissionFixture>>, account?: string) {
  const f = initial ?? (await fixture());
  const vault = createSqlVaultStore(f.sql);
  const credentials = launchCredentials(vault, launchEncryptionKey);
  const caller: Caller = { via: "service", userId: f.people.owner, orgs: [{ orgId: f.people.org, role: "member" }] };
  const id = account
    ? await (async () => {
        const fail = () => {
          throw Error("Launch must go through the Modal job");
        };
        const response = await launchRoute(
          {
            data: createSqlData(f.sql),
            providerFor: fail,
            store: vault,
            encryptionKey: launchEncryptionKey,
            admitModalLaunch: createModalLaunchAdmission(
              f.sql,
              {
                policy: { start: fail },
                provider: async () => ({ ...fakeBoat().provider, id: "modal", harnesses: HARNESSES }),
                credentials,
                connections: { async validate() {}, async bind() {} },
              },
              {},
              (input) => admitModalLaunch(f.sql, launchEncryptionKey, input),
            ),
          },
          caller,
          {
            provider: "modal",
            golden: "modal-admission",
            harness: "antigravity",
            credentialId: account,
            model: "default",
            prompt: "Reply once",
            org: f.people.org,
          },
        );
        return modalLaunchReceipt.parse(response).sandbox.id;
      })()
    : initial
      ? (
          await admitModalLaunch(f.sql, launchEncryptionKey, {
            ...initial.input,
            sandbox: { ...initial.input.sandbox, credentialId: f.openaiCredentialId, credentialVersion: 1 },
          })
        ).sandbox.id
      : await unboundModalSandbox(f);
  await f.db.query(
    `insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment)
     values($1,'owner','user',$2,'test','ap-test','main')`,
    [f.people.org, f.people.owner],
  );
  const jobId = initial
    ? (await f.db.query<{ id: string }>("select id from jobs where sandbox_id=$1 and kind='launch'", [id])).rows[0]!.id
    : await f.store.enqueue("launch", id, 2, id, null, {
        orgId: f.people.org,
        maxAttempts: 3,
        deadline: new Date("2100-01-01T00:00:00Z"),
        request: { ownerId: f.people.owner, digest: "fixture" },
      });
  let allocations = 0;
  let observed = 0;
  let exited = false;
  let visible = true;
  let terminations = 0;
  let checkpoints = 0;
  let baselineCaptures = 0;
  let modalClient: ModalMachineOptions["client"] | undefined;
  let cleanupPreparations = 0;
  let closedClients = 0;
  const modalCredential = (
    await f.db.query<{ id: string; version: number }>(
      `insert into public.credentials(scope,owner_id,kind,value_enc)
     values('user',$1,'modal',decode('00','hex')) returning id,version`,
      [f.people.owner],
    )
  ).rows[0]!;
  let tags: Record<string, string> = {};
  const bootstrapped: string[] = [];
  const enrolments = createRuntimeEnrolments(f.sql, launchEncryptionKey);
  let enrolmentToken: string;
  let activeRuntime: Awaited<ReturnType<typeof enrolments.enrol>> | undefined;
  const makeRunner = (
    atStep?: (step: ModalLaunchStep) => void | Promise<void>,
    jobsSql = f.sql,
    enrol = true,
    artifactManifest = modalTestArtifactManifest("a"),
  ) => {
    const sandbox = {
      sandboxId: "physical",
      getTags: async () => tags,
      poll: async () => {
        observed++;
        await atStep?.("machine poll");
        return exited || terminations ? 0 : null;
      },
      async terminate() {
        terminations++;
        await atStep?.("termination response");
      },
      async snapshotFilesystem() {
        checkpoints++;
        return { imageId: "im-retained" };
      },
      async exec(args: string[]) {
        if (args.includes(outputEntryCollector(null))) {
          return {
            stdin: { close: async () => {} },
            stdout: { readText: async () => "[]" },
            wait: async () => 0,
          };
        }
        if (args.includes("/usr/sbin/runuser")) {
          return {
            stdin: { writeText: async () => {}, close: async () => {} },
            stdout: {
              async readText() {
                return JSON.stringify({
                  detached: false,
                  exitCode: 0,
                  stdout: '{"status":"clean"}',
                  stderr: "",
                  timedOut: false,
                  truncated: false,
                });
              },
            },
            wait: async () => 0,
          };
        }
        if (args.includes("/opt/armada/runtime-bun/bun")) {
          let input: { op: string; physicalId: string; generation: number };
          return {
            stdin: {
              async writeText(value: string) {
                input = JSON.parse(value);
                if (input.op === "capture") baselineCaptures++;
              },
              close: async () => {},
            },
            stdout: {
              async readText() {
                if (input.op === "capture") await atStep?.("baseline capture response");
                return input.op === "capture"
                  ? JSON.stringify({
                      version: 1,
                      physicalId: input.physicalId,
                      generation: input.generation,
                      namespace: { pid: "pid", mount: "mount" },
                      processes: [{ pid: 1, start: "1" }],
                      admissionState: "pending",
                    })
                  : "{}";
              },
            },
            wait: async () => 0,
          };
        }
        if (args[0] === "bash") return { wait: async () => 0 };
        await atStep?.("bootstrap dispatch");
        const { rows } = await f.db.query<{ provider_sandbox_id: string }>(
          "select provider_sandbox_id from sandboxes where id=$1",
          [id],
        );
        bootstrapped.push(rows[0]!.provider_sandbox_id);
        return {
          stdin: {
            async writeText(value: string) {
              enrolmentToken = JSON.parse(value).enrolmentToken;
            },
            close: async () => {},
          },
          async wait() {
            if (enrol) activeRuntime = await enrolments.enrol(enrolmentToken);
            await atStep?.("bootstrap response");
            return 0;
          },
        };
      },
    };
    const client = {
      apps: { fromName: async () => ({ appId: "ap-test" }) },
      images: {
        async fromId(ref: string) {
          expect(ref).toBe(initial ? "im-snapshot" : "image");
          await atStep?.("image lookup");
          return { imageId: "image" };
        },
      },
      sandboxes: {
        async experimentalCreate(_app: unknown, _image: unknown, options: { tags: Record<string, string> }) {
          allocations++;
          tags = options.tags;
          await atStep?.("create response");
          return sandbox;
        },
        fromName: async () => {
          if (!visible) throw new Error("Allocation lookup unavailable");
          return sandbox;
        },
        fromId: async () => ({
          ...sandbox,
          async getTags() {
            await atStep?.("exact machine ownership");
            return tags;
          },
        }),
      },
    } as unknown as ModalMachineOptions["client"];
    modalClient = client;
    const machine: Omit<ModalMachineOptions, "journal"> = {
      client,
      appName: "test",
      binding: { appId: "ap-test", workspace: "workspace", environment: "main" },
      deploymentId: "deployment",
      resolveRuntimeTicket: async () => null,
      prepareCheckpoint: async () => {},
    };
    const prepareRuntimeTicket = async () => {
      await atStep?.("runtime ticket");
      return {
        ownerId: f.people.owner,
        configuration: { artifactManifest, grant: { expiresAt: 1 } },
        serverUrl: "https://armada.invalid",
        artifact: artifactManifest.runtime,
        cacheDir: "/home/user/runtime-cache",
        async lockPrerequisites() {},
        accountPin: { credentialId: null, credentialVersion: null },
      };
    };
    const launch = initial
      ? createModalLaunchJob(
          jobsSql,
          launchEncryptionKey,
          async (app) => {
            await atStep?.("open Modal");
            expect(app).toEqual({
              binding: machine.binding,
              appName: machine.appName,
              credentialScope: "user",
              credentialOwnerId: f.people.owner,
            });
            return {
              ...machine,
              modalCredential: async () => {
                await atStep?.("dispatch credential");
                return modalCredential;
              },
              close() {
                closedClients++;
              },
            };
          },
          async (target) => ({
            ...(await prepareRuntimeTicket()),
            ...(account
              ? await runtimeConfigurationWithVariables(
                  jobsSql,
                  {
                    actor: { orgId: target.orgId, userId: target.ownerId, role: "member" },
                    sandbox: target,
                    credentials: await credentials.resolve(
                      { orgId: target.orgId, userId: target.ownerId, role: "member" },
                      target.harness,
                      target.credentialId ?? undefined,
                      target.credentialVersion ?? undefined,
                    ),
                    manifest: artifactManifest,
                    architecture: "x64",
                  },
                  "modal",
                  "modal_runtime_empty_v1",
                )
              : {}),
            ...modalLaunchTicketGuard(target),
          }),
        )
      : {
          concurrency: 1,
          run(job: Job, context: JobContext) {
            return runModalLaunch(jobsSql, launchEncryptionKey, job, context, () => ({
              allocation: { source: { kind: "image", ref: "image" }, size: null, computeTtlSeconds: 600 },
              computeExpiresAt: new Date(Date.now() + 600_000),
              bindingRef: job.id,
              placement: {
                scope: { orgId: f.people.org, userId: f.people.owner, visibility: "private", binding: machine.binding },
                sourceVisibility: "private",
                snapshot: "snapshot",
                imageId: "image",
                managementAuthority: { credentialScope: "user", credentialOwnerId: f.people.owner },
              },
              machine,
              modalCredential: async () => {
                await atStep?.("dispatch credential");
                return modalCredential;
              },
              prepareRuntimeTicket,
            }));
          },
        };
    return createJobsRunner(
      createJobsStore(jobsSql, launchEncryptionKey),
      {
        delete: createModalLaunchCleanupJob(
          jobsSql,
          async ({ binding, appName, credentialScope, credentialOwnerId }) => {
            cleanupPreparations++;
            await atStep?.("cleanup preparation");
            if (credentialScope !== "user" || credentialOwnerId !== f.people.owner)
              throw new Error("Wrong credential slot for the registered App");
            return {
              ...machine,
              binding,
              appName,
              close() {
                closedClients++;
              },
            };
          },
        ),
        launch,
      },
      () => {},
      () => () => {},
    );
  };
  return {
    f,
    id,
    jobId,
    makeRunner,
    hideAllocation: () => {
      visible = false;
    },
    revealAllocation: () => {
      visible = true;
    },
    exitAllocation: () => {
      exited = true;
    },
    effects: () => ({ allocations, observed, bootstrapped }),
    cleanupEffects: () => ({ terminations, cleanupPreparations }),
    retentionEffects: () => ({ checkpoints, baselineCaptures }),
    retentionHost() {
      const scope = {
        orgId: f.people.org,
        userId: f.people.owner,
        visibility: "private" as const,
        binding: { workspace: "workspace", environment: "main", appId: "ap-test" },
      };
      const refuseUnexpected = async () => {
        throw new Error("Unexpected Modal provider call");
      };
      return createModalProvider({
        client: modalClient as NonNullable<Parameters<typeof createModalProvider>[0]["client"]>,
        appName: "test",
        scope,
        store: createSqlModalStore(f.sql, scope),
        distribution: {
          capabilities: {},
          image: refuseUnexpected,
          prepareSnapshot: prepareFilesystemSnapshot,
        },
      });
    },
    closedClients: () => closedClients,
    revokeModalCredential: () =>
      f.db.query("update public.credentials set status='revoked' where id=$1", [modalCredential.id]),
    activeRuntime: () => activeRuntime!,
    enrolPending: (authority = enrolments) => authority.enrol(enrolmentToken),
  };
}

const fixtureWorkspaceCommands: Pick<ReturnType<typeof createRuntimeCommands>, "call"> = {
  async call(_owner, request, options) {
    const epoch = options?.expectedEpoch ?? "";
    const result =
      request.op === "health"
        ? { ready: true, generation: epoch, workspaceVersion: 1 }
        : { detached: false, exitCode: 0, stdout: "", stderr: "" };
    return {
      epoch,
      requestId: request.requestId,
      status: 200,
      body: { version: 1, requestId: request.requestId, result },
    };
  },
};

async function modalFirstTurnLane(
  f: Awaited<ReturnType<typeof fixture>>,
  accountTurns: Pick<ReturnType<typeof createAccountTurnQueue>, "acceptInitialLaunch">,
  runtimeCommands = fixtureWorkspaceCommands,
  runtimeGitHub?: ReturnType<typeof createRuntimeGitHub>,
  runtimeMcp: Pick<RuntimeMcp, "prepare"> = { prepare: async () => undefined },
  sandboxArmadaAccess?: ReturnType<typeof createSandboxArmadaAccess>,
) {
  const factory = await registeredJobsLane();
  return factory({
    sql: f.sql,
    jobs: f.store,
    accountTurns,
    runtimeCommands,
    runtimeGitHub,
    runtimeMcp,
    config: { encryptionKey: launchEncryptionKey },
    resumeJob: {
      concurrency: 1,
      async run() {
        throw new Error("Unexpected resume in launch setup fixture.");
      },
    },
    options: { logError: () => {} },
    control: { sandboxArmadaAccess },
    langfuse: { exportJob: { concurrency: 1 } },
    webhooks: {},
    outputs: { drain: async () => {}, captureJob: { concurrency: 1 } },
    modal: { launchCleanupJob: { concurrency: 1 } },
  } as unknown as Parameters<LaneFactory>[0])!;
}

test("Modal launches Antigravity with a selected account confined to private enrolment", async () => {
  const admission = await modalAdmissionFixture();
  const vault = createSqlVaultStore(admission.sql);
  const key = "fixture-private-gemini-value";
  await setCredential(vault, launchEncryptionKey, admission.people.owner, {
    scope: "user",
    org: undefined,
    kind: "antigravity",
    value: key,
  });
  const account = (await vault.credentials("user", admission.people.owner)).find(({ kind }) => kind === "antigravity");
  if (!account?.id) throw Error("Missing Antigravity account");
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission, account.id);
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(
    (await f.db.query("select state,outcome from jobs where sandbox_id=$1 and kind='launch'", [id])).rows,
  ).toMatchObject([{ state: "done" }]);
  const { antigravityCredential, ...configuration } = activeRuntime().configuration as Record<string, unknown>;
  expect(antigravityCredential).toEqual({ method: "gemini-api-key", apiKey: key });
  expect(configuration.selectedHarness).toBe("antigravity");
  const rows = (
    await f.db.query(
      "select s.harness,s.model,s.credential_id,j.payload_enc,j.outcome from sandboxes s join jobs j on j.sandbox_id=s.id where s.id=$1",
      [id],
    )
  ).rows;
  expect(rows).toContainEqual(
    expect.objectContaining({ harness: "antigravity", model: "default", credential_id: account.id }),
  );
  expect(JSON.stringify([configuration, rows])).not.toContain(key);
});

test("Modal admission and deferred enrolment wake jobs and stay within the SQL statement budget", async () => {
  const statements: string[] = [];
  const checkpoints: number[] = [];
  const admission = await modalAdmissionFixture("private", statements);
  const log = spyOn(console, "info");
  let jobWakes = 0;
  const unsubscribe = runtimeWakes.subscribe(JOBS_WAKE, () => {
    jobWakes++;
  });
  try {
    await observeGoldenLaunch("rest", async (timing) => {
      const { f, id, makeRunner, enrolPending } = await modalLaunchFixture(admission);
      checkpoints.push(statements.length);
      const runner = makeRunner(undefined, f.sql, false);
      expect(await runner.reconcileOne(signal)).toBe(true);
      await runner.drain();
      checkpoints.push(statements.length);
      expect(
        await createJobsStore(f.db, launchEncryptionKey).claim(MODAL_INITIAL_TURN, crypto.randomUUID(), 30, 1),
      ).toBeUndefined();
      const wakesBeforeEnrol = jobWakes;
      await enrolPending();
      expect(jobWakes).toBeGreaterThan(wakesBeforeEnrol);
      checkpoints.push(statements.length);
      const wakesBeforeDone = jobWakes;
      expect(await runner.reconcileOne(signal)).toBe(true);
      await runner.drain();
      expect(jobWakes).toBeGreaterThan(wakesBeforeDone);
      expect((await f.db.query("select state from jobs where sandbox_id=$1 and kind='launch'", [id])).rows).toEqual([
        { state: "done" },
      ]);
      expect(
        await createJobsStore(f.db, launchEncryptionKey).claim(MODAL_INITIAL_TURN, crypto.randomUUID(), 30, 1),
      ).toMatchObject({ sandbox_id: id, kind: MODAL_INITIAL_TURN });
      checkpoints.push(statements.length);
      timing.checkpoint("shared_launcher");
    });
    const sample = log.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .find(({ event }) => event === "modal_golden_launch_timing");
    expect(statements.length).toBe(sample?.sqlStatements);
    expect(statements.length).toBeLessThanOrEqual(60);
    expect(checkpoints.map((total, phase) => total - (checkpoints[phase - 1] ?? 0))).toEqual([8, 35, 9, 8]);
  } finally {
    unsubscribe();
    log.mockRestore();
  }
});

test("Modal launch rechecks membership after the lease lock if its first snapshot misses the owner", async () => {
  const { f, effects, makeRunner, enrolPending, jobId } = await modalLaunchFixture(await modalAdmissionFixture());
  let missedMembership = false;
  const runner = makeRunner(
    undefined,
    {
      ...f.sql,
      async transaction(work) {
        return f.sql.transaction!((tx) =>
          work({
            ...tx,
            query<T>(query: string, params?: unknown[]) {
              if (!missedMembership && query.includes("as owner_member")) {
                missedMembership = true;
                query = query.replace(
                  "m.user_id=j.request_owner_id for share",
                  "m.user_id=j.request_owner_id and false for share",
                );
              }
              return tx.query<T>(query, params);
            },
          }),
        );
      },
    },
    false,
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(missedMembership).toBe(true);
  expect(effects()).toMatchObject({ allocations: 1, bootstrapped: ["physical"] });
  await enrolPending();
  await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "done" }]);
});

test("JWT inventory keeps an enrolled Modal sandbox starting while launch setup is queued", async () => {
  const { f, id, makeRunner } = await modalLaunchFixture(await modalAdmissionFixture());
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();

  await f.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [f.people.owner]);
    await tx.exec("set local role authenticated");
    const { rows } = await tx.query("select status from public.sandbox_list_metadata() where id=$1", [id]);
    expect(rows).toEqual([{ status: "starting" }]);
    expect((await tx.query("select public.sandbox_detail_status($1,$2) as status", [id, f.people.org])).rows).toEqual([
      { status: "starting" },
    ]);
  });
});

test.each([
  { prompted: false, max: null, limits: { "gpt-5": 1 }, refusal: "Model gpt-5" },
  { prompted: true, max: 1, limits: {}, refusal: "1/1 agents working" },
])("Modal enrolment preserves capacity through setup ($refusal)", async ({ prompted, max, limits, refusal }) => {
  const fixture = await modalAdmissionFixture();
  if (!prompted) delete fixture.input.initialPrompt;
  const { f, id, makeRunner } = await modalLaunchFixture(fixture);
  await f.db.query("update credentials set max_agents=$2,model_limits=$3 where id=$1", [
    f.openaiCredentialId,
    max,
    limits,
  ]);
  const launch = makeRunner();
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);

  const anotherLaunch = () =>
    admitModalLaunch(f.sql, launchEncryptionKey, {
      ...fixture.input,
      request: { key: "second-launch", payload: "second" },
      sandbox: { ...fixture.input.sandbox, credentialId: f.openaiCredentialId, credentialVersion: 1 },
    });
  await expect(anotherLaunch()).rejects.toThrow(refusal);

  const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
  const setup = await modalFirstTurnLane(f, queue);
  expect(await setup.reconcileOne(signal)).toBe(true);
  await setup.drain();
  expect(
    (await f.db.query("select state from jobs where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN])).rows,
  ).toEqual([{ state: "done" }]);

  if (prompted) {
    const owner = crypto.randomUUID();
    const store = createJobsStore(f.sql, launchEncryptionKey);
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    expect(
      await admitClaimedAccountTurn(f.sql, {
        job,
        canDispatch: async (tx) => (await store.inspect(job, owner, tx)) === "dispatch",
      }),
    ).not.toBeNull();
  }
  if (prompted) await expect(anotherLaunch()).rejects.toThrow(refusal);
  else expect((await anotherLaunch()).sandbox.status).toBe("starting");
});

test.each(["first turn", "promptless setup"] as const)(
  "Modal scoped access is acknowledged before %s completes after a lost reference reply",
  async (mode) => {
    const fixture = await modalAdmissionFixture();
    const admission = { ...fixture, input: { ...fixture.input, armadaAccess: {} } };
    if (mode === "promptless setup") delete admission.input.initialPrompt;
    const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission);
    const launch = makeRunner();
    expect(await launch.reconcileOne(signal)).toBe(true);
    await launch.drain();

    const { runtimeToken, epoch } = activeRuntime();
    const enrolments = createRuntimeEnrolments(f.sql, launchEncryptionKey);
    const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
    const turns = async () =>
      (await f.db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows;
    const referenceCommands: string[] = [];
    let grants = 0;
    const runSetup = async (interrupt: boolean, loseAfterGrant = false) => {
      const commands = createRuntimeCommands(enrolments, launchEncryptionKey, {
        now: () => 0,
        async wait() {
          const { command } = await commands.next(runtimeToken, epoch);
          if (!command) throw new Error("Expected a runtime setup command.");
          expect(await turns()).toEqual([]);
          let result: unknown;
          switch (command.op) {
            case "health":
              result = { ready: true, generation: epoch, workspaceVersion: 1 };
              break;
            case "workspaceExec":
              if (command.input.command.includes(".agents/skills/armada-tools/SKILL.md")) {
                expect(command.input).toMatchObject({ phase: "init", index: 100, attempt: 0 });
                referenceCommands.push(command.requestId);
                if (interrupt) throw new Error("Worker lost while waiting for the reference command.");
              }
              result = { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
              break;
            case "installOrchestratorEpoch":
              grants++;
              result = { acknowledged: true };
              break;
            default:
              throw new Error("Unexpected runtime setup command.");
          }
          await commands.complete(runtimeToken, epoch, {
            epoch,
            requestId: command.requestId,
            status: 200,
            body: { version: 1, requestId: command.requestId, result },
          });
        },
      });
      const access = createSandboxArmadaAccess({
        sql: f.sql,
        encryptionKey: launchEncryptionKey,
        publicUrl: "https://armada.test",
        commands,
      });
      const lane = await modalFirstTurnLane(
        f,
        loseAfterGrant
          ? {
              async acceptInitialLaunch() {
                throw new Error("Worker lost after the grant acknowledgement.");
              },
            }
          : queue,
        commands,
        undefined,
        undefined,
        access,
      );
      expect(await lane.reconcileOne(signal)).toBe(true);
      await lane.drain();
    };

    const expireClaim = () =>
      f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN]);
    const grantReceipts = async () =>
      (
        await f.db.query(
          "select acknowledged_at is not null as acknowledged from orchestrator_delegations where orchestrator_id=$1",
          [id],
        )
      ).rows;

    await runSetup(true);
    expect(referenceCommands).toHaveLength(1);
    expect(grants).toBe(0);
    expect(await turns()).toEqual([]);
    await expireClaim();

    if (mode === "first turn") {
      await runSetup(false, true);
      expect(await grantReceipts()).toEqual([{ acknowledged: true }]);
      expect(await turns()).toEqual([]);
      await expireClaim();
    }
    await runSetup(false);
    expect(referenceCommands).toEqual([referenceCommands[0]!, referenceCommands[0]!]);
    expect(grants).toBe(1);
    expect(await turns()).toHaveLength(mode === "first turn" ? 1 : 0);
    expect(
      (await f.db.query("select state from jobs where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN])).rows,
    ).toEqual([{ state: "done" }]);
    expect(await grantReceipts()).toEqual([{ acknowledged: true }]);
  },
);

test.each(["before", "after"] as const)(
  "the registered Modal first-turn job recovers a crash %s queue commit",
  async (crash) => {
    const admission = await modalAdmissionFixture();
    const { f, id, makeRunner } = await modalLaunchFixture(admission);
    const { db, sql } = f;
    const {
      rows: [intent],
    } = await db.query<{ id: string }>("select id from jobs where sandbox_id=$1 and kind='launch_initial_turn'", [id]);
    const queue = createAccountTurnQueue(sql, launchEncryptionKey);
    const claim = async (lane: Awaited<ReturnType<typeof modalFirstTurnLane>>) => {
      expect(await lane.reconcileOne(signal)).toBe(true);
      await lane.drain();
    };
    const turns = () =>
      db.query<{ request_id: string; input_enc: Uint8Array<ArrayBuffer> }>(
        "select request_id,input_enc from account_turn_queue where sandbox_id=$1",
        [id],
      );
    const intentState = async () =>
      (await db.query("select state,attempts from jobs where id=$1", [intent!.id])).rows[0];
    const dispatchJobs = () => db.query("select kind from jobs where sandbox_id=$1 and kind='turn_dispatch'", [id]);

    const expiringSql = sqlOver({
      unsafe: async (query, params) => (await db.query(query, params)).rows,
      begin: (work) =>
        db.transaction((tx) =>
          work({
            async unsafe(query, params) {
              const result = await tx.query(query, params);
              if (query.includes("insert into public.account_turn_queue")) {
                await tx.query("update public.jobs set lease_until='-infinity' where id=$1", [intent!.id]);
              }
              return result.rows;
            },
          }),
        ),
    });
    const interruptedQueue = {
      async acceptInitialLaunch(...args) {
        if (crash === "before")
          return createAccountTurnQueue(expiringSql, launchEncryptionKey).acceptInitialLaunch(...args);
        await queue.acceptInitialLaunch(...args);
        throw new Error("Lost worker");
      },
    } satisfies Pick<typeof queue, "acceptInitialLaunch">;
    await claim(await modalFirstTurnLane(f, queue));
    expect(await intentState()).toEqual({ state: "queued", attempts: 0 });
    expect((await turns()).rows).toHaveLength(0);

    await claim(makeRunner());
    await db.query("update jobs set run_after='-infinity',attempts=$2 where id=$1", [
      intent!.id,
      crash === "after" ? 2 : 0,
    ]);
    await claim(await modalFirstTurnLane(f, interruptedQueue));
    expect(await intentState()).toEqual({ state: "leased", attempts: crash === "after" ? 3 : 1 });
    expect((await turns()).rows).toHaveLength(crash === "after" ? 1 : 0);
    expect((await dispatchJobs()).rows).toHaveLength(crash === "after" ? 1 : 0);
    const caller: Caller = {
      userId: f.people.owner,
      orgs: [{ orgId: f.people.org, role: "member" }],
      via: "service",
    };
    const followup = { id, request_id: crypto.randomUUID(), prompt: "Follow up" };
    expect(await queue.accept(caller, followup)).toMatchObject({ status: "queued", promptId: followup.request_id });

    await db.query("update jobs set lease_until='-infinity' where id=$1", [intent!.id]);
    await claim(await modalFirstTurnLane(f, queue));
    expect(await intentState()).toEqual({ state: "done", attempts: crash === "after" ? 4 : 2 });
    const { rows } = await turns();
    expect(rows).toHaveLength(2);
    const initial = rows.find(({ request_id }) => request_id === intent!.id);
    expect(initial).toBeDefined();
    expect(JSON.parse(await decryptSecret(initial!.input_enc, launchEncryptionKey))).toMatchObject({
      prompt: admission.input.initialPrompt,
    });
    expect(await queue.status(caller, id, followup.request_id)).toMatchObject({ failed: false });
    expect((await dispatchJobs()).rows).toHaveLength(2);
  },
);

test("the Modal launch prompt dispatches its own receipt through the account worker", async () => {
  const admission = await modalAdmissionFixture();
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission);
  const launch = makeRunner();
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();

  const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
  const setup = await modalFirstTurnLane(f, queue);
  expect(await setup.reconcileOne(signal)).toBe(true);
  await setup.drain();
  const receipt = async () =>
    (
      await f.db.query<{ request_id: string; state: string }>(
        "select request_id,state from account_turn_queue where sandbox_id=$1",
        [id],
      )
    ).rows[0]!;
  const { request_id } = await receipt();
  const { runtimeToken, epoch } = activeRuntime();
  const authority = createRuntimeEnrolments(f.sql, launchEncryptionKey);
  const commands = createRuntimeCommands(authority, launchEncryptionKey, {
    now: () => 0,
    async wait() {
      const { command } = await commands.next(runtimeToken, epoch);
      if (command?.op !== "prompt") throw new Error("Expected the launch prompt.");
      expect(command.input.text).toBe(admission.input.initialPrompt!);
      await commands.complete(runtimeToken, epoch, {
        epoch,
        requestId: command.requestId,
        status: 200,
        body: {
          version: 1,
          requestId: command.requestId,
          result: { promptId: "initial-prompt", conversationId: command.input.conversationId, status: "running" },
        },
      });
    },
  });
  const runtimeSend = createRuntimeFollowup(f.sql, launchEncryptionKey, commands);
  const caller = { userId: f.people.owner, orgs: [{ orgId: f.people.org, role: "member" }], via: "service" } as const;
  const dispatch = createQueuedSandboxDispatch({
    authStore: createMemoryAuthStore(),
    supabase: { supabaseUrl: "https://unused.test", anonKey: "fixture" },
    store: createSqlVaultStore(f.sql),
    encryptionKey: launchEncryptionKey,
    data: createSqlData(f.sql),
    providers: {
      async resolve() {
        throw new Error("Modal launch prompt must use the runtime.");
      },
    },
    runtimeSend,
  });
  const turns = createJobsRunner(
    createJobsStore(f.sql, launchEncryptionKey),
    {
      turn_dispatch: createTurnDispatchJob(f.sql, launchEncryptionKey, async (...args) => {
        await expect(runtimeSend(caller, { id, request_id, prompt: "Unrelated prompt" })).rejects.toMatchObject({
          reason: "modal_launch_prompt_pending",
        });
        return dispatch(...args);
      }),
    },
    () => {},
    () => () => {},
  );
  expect(await turns.reconcileOne(signal)).toBe(true);
  await turns.drain();
  expect(await receipt()).toEqual({ request_id, state: "admitted" });
  expect(await queue.status(caller, id, request_id)).toEqual({ nativePromptId: "initial-prompt" });
});

test("a replacement Modal setup claimant replays workspace commands before admitting the first turn", async () => {
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(await modalAdmissionFixture());
  const launch = makeRunner();
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();

  const { runtimeToken, epoch } = activeRuntime();
  const authority = createRuntimeEnrolments(f.sql, launchEncryptionKey);
  const turns = async () =>
    (await f.db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows;
  const commandsSeen: string[] = [];
  let pendingRepository = "";
  let capability: { url: string; value: string } | undefined;
  const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
  await f.db.query(
    `insert into github_connections(user_id,github_id,login,name,refresh_token_enc,access_token_enc,access_expires_at)
     values($1,123,'owner','Owner',$2,$2,'2100-01-01')`,
    [f.people.owner, await encryptSecret("fixture", launchEncryptionKey)],
  );
  const caller = { userId: f.people.owner, orgs: [{ orgId: f.people.org, role: "member" }], via: "service" } as const;
  const runSetup = async (interrupt: boolean) => {
    const bridge = createRuntimeCommands(authority, launchEncryptionKey, {
      now: () => 0,
      async wait() {
        const { command } = await bridge.next(runtimeToken, epoch);
        if (!command) throw new Error("Expected a runtime command.");
        expect(await turns()).toEqual([]);
        commandsSeen.push(command.op === "workspaceExec" ? command.input.phase : command.op);
        if (command.op === "configureGitHub") {
          const config = command.configuration;
          expect(config?.repositories).toEqual(["example/workspace"]);
          if (!config) throw Error("Expected an active GitHub configuration.");
          capability = { url: config.url, value: config.capability };
        }
        if (command.op === "workspaceExec" && command.input.phase === "repository") {
          if (interrupt) {
            pendingRepository = command.requestId;
            throw Error("Worker lost while the repository command was pending.");
          }
          expect(command.requestId).toBe(pendingRepository);
          if (!capability) throw Error("Expected the original GitHub capability.");
          const redeem = (repository: string) =>
            github.route(
              new Request(capability!.url, {
                method: "POST",
                headers: { authorization: `Bearer ${capability!.value}` },
                body: JSON.stringify({ version: 1, repository, operation: "git" }),
              }),
            );
          expect((await redeem("example/workspace"))?.status).toBe(200);
          expect((await redeem("example/replacement"))?.status).toBe(403);
        }
        if (command.op === "workspaceExec" && command.input.phase === "init")
          expect(command.input.command).toBe(workspaceConfig.init[0]!);
        const result =
          command.op === "health"
            ? { ready: true, generation: epoch, workspaceVersion: 1 }
            : command.op === "configureGitHub"
              ? { acknowledged: true }
              : { detached: false, exitCode: 0, stdout: "", stderr: "" };
        await bridge.complete(runtimeToken, epoch, {
          epoch,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result },
        });
      },
    });
    const github = createRuntimeGitHub({
      sql: f.sql,
      key: launchEncryptionKey,
      origin: "https://armada.test",
      commands: bridge,
      github: {
        store: createSqlVaultStore(f.sql),
        encryptionKey: launchEncryptionKey,
        app: { clientId: "app", clientSecret: "fixture" },
        fetch: Object.assign(async () => Response.json({ id: 123, login: "owner", name: "Owner" }), {
          preconnect: () => {},
        }),
      },
    });
    const lane = await modalFirstTurnLane(f, queue, bridge, github);
    expect(await lane.reconcileOne(signal)).toBe(true);
    await lane.drain();
    expect(await github.status({ ...caller, orgs: [...caller.orgs] }, id)).toMatchObject({ configured: true });
  };

  await runSetup(true);
  expect(commandsSeen).toEqual(["health", "configureGitHub", "repository"]);
  expect(await turns()).toEqual([]);
  await f.db.query("update goldens set config=$1 where name='modal-admission'", [
    {
      repos: [{ ...workspaceConfig.repos[0], url: "https://github.com/example/replacement" }],
      init: ["printf replacement"],
    },
  ]);
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN]);
  await runSetup(false);
  expect(commandsSeen).toEqual(["health", "configureGitHub", "repository", "repository", "init"]);
  expect(await turns()).toHaveLength(1);
});

test("Modal setup recovers private skill installation after credential rotation", async () => {
  const admission = await modalAdmissionFixture();
  const reference = "tool@1.0.0";
  admission.input.resolvedSkills = [reference];
  admission.input.sandbox.repositoryDir = "workspace";
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission);
  const { db, people, sql } = f;
  const launch = makeRunner();
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();

  const { runtimeToken, epoch } = activeRuntime();
  const authority = createRuntimeEnrolments(sql, launchEncryptionKey);
  const queue = createAccountTurnQueue(sql, launchEncryptionKey);
  const turns = async () =>
    (await db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows;
  const receipts = [
    {
      reference,
      version: "1.0.0",
      skillId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      checksum: `sha256:${"a".repeat(64)}`,
      origin: "https://skillpack.app/v1",
    },
  ];
  const initialKey = ["cmp", "pat", "a".repeat(48)].join("_");
  const admittedKey = ["cmp", "pat", "b".repeat(48)].join("_");
  const rotateKey = async (key: string) => {
    await db.query("update credentials set value_enc=$1 where owner_id=$2 and kind='skillpack'", [
      await encryptSecret(key, launchEncryptionKey),
      people.owner,
    ]);
  };
  await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'skillpack',$2)", [
    people.owner,
    await encryptSecret(initialKey, launchEncryptionKey),
  ]);
  const installs: string[] = [];
  const runSetup = async (interrupt: boolean) => {
    const bridge = createRuntimeCommands(authority, launchEncryptionKey, {
      now: () => 0,
      async wait() {
        const { command } = await bridge.next(runtimeToken, epoch);
        if (!command) throw Error("Expected a runtime command.");
        let result: unknown = { detached: false, exitCode: 0, stdout: "", stderr: "" };
        if (command.op === "health") {
          if (interrupt && command.requestId.startsWith("skills_")) await rotateKey(admittedKey);
          result = { ready: true, generation: epoch, workspaceVersion: 1, skillsVersion: 1 };
        }
        if (command.op === "installSkills") {
          expect(command.input.references).toEqual([reference]);
          expect(command.input.cwd).toBe("/home/user/workspace");
          expect(command.input.key === admittedKey).toBe(true);
          installs.push(command.requestId);
          expect(await turns()).toEqual([]);
          if (interrupt) throw Error("Worker lost after skill command admission.");
          result = { receipts };
        }
        await bridge.complete(runtimeToken, epoch, {
          epoch,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result },
        });
      },
    });
    const lane = await modalFirstTurnLane(f, queue, bridge, undefined, {
      async prepare() {
        expect((await db.query("select skills from sandboxes where id=$1", [id])).rows).toEqual([{ skills: receipts }]);
        expect(await turns()).toEqual([]);
        return undefined;
      },
    });
    expect(await lane.reconcileOne(signal)).toBe(true);
    await lane.drain();
  };

  await runSetup(true);
  expect(installs).toHaveLength(1);
  expect(await turns()).toEqual([]);
  await rotateKey(["cmp", "pat", "c".repeat(48)].join("_"));
  await db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN]);

  await runSetup(false);
  expect(installs).toEqual([installs[0]!, installs[0]!]);
  expect(await turns()).toHaveLength(1);
});

test("a replacement Modal setup claimant completes the admitted MCP revision before queueing the first turn", async () => {
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(await modalAdmissionFixture());
  const launch = makeRunner();
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();

  const { runtimeToken, epoch } = activeRuntime();
  const authority = createRuntimeEnrolments(f.sql, launchEncryptionKey);
  const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
  const turns = async () =>
    (await f.db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows;
  const configurations: string[] = [];
  let mcpHealthCommands = 0;
  const runSetup = async (interrupt: boolean) => {
    const bridge = createRuntimeCommands(authority, launchEncryptionKey, {
      now: () => 0,
      async wait() {
        const { command } = await bridge.next(runtimeToken, epoch);
        if (!command) throw Error("Expected a runtime command.");
        expect(await turns()).toEqual([]);
        let result: unknown = { detached: false, exitCode: 0, stdout: "", stderr: "" };
        if (command.op === "health") {
          if (!command.requestId.startsWith("workspace_health_")) mcpHealthCommands++;
          result = { ready: true, generation: epoch, workspaceVersion: 1, mcpVersion: 1 };
        }
        if (command.op === "configureMcp") {
          expect(command.configuration.servers.armada_self).toBeDefined();
          configurations.push(command.requestId);
          if (interrupt) throw Error("Worker lost after MCP command admission.");
          result = { revision: command.configuration.revision };
        }
        await bridge.complete(runtimeToken, epoch, {
          epoch,
          requestId: command.requestId,
          status: 200,
          body: { version: 1, requestId: command.requestId, result },
        });
      },
    });
    const mcp = createRuntimeMcp({
      sql: f.sql,
      key: launchEncryptionKey,
      origin: "https://armada.test",
      commands: bridge,
    });
    const lane = await modalFirstTurnLane(f, queue, bridge, undefined, mcp);
    expect(await lane.reconcileOne(signal)).toBe(true);
    await lane.drain();
  };

  await runSetup(true);
  expect(configurations).toHaveLength(1);
  expect(await turns()).toEqual([]);
  const [configuration] = configurations;
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN]);

  await runSetup(false);
  expect(configurations).toEqual([configuration!, configuration!]);
  expect(mcpHealthCommands).toBe(1);
  expect((await f.db.query("select configured from mcp_bootstraps where sandbox_id=$1", [id])).rows).toEqual([
    { configured: true },
  ]);
  expect(await turns()).toHaveLength(1);
});

test.each(["acknowledgement lost", "promptless takeover", "secret revoked", "sandbox untainted"] as const)(
  "the Modal first-turn worker fences runtime configuration when %s",
  async (scenario) => {
    const admission = await modalAdmissionFixture();
    if (scenario === "promptless takeover") delete admission.input.initialPrompt;
    const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission);
    const { db, people, sql } = f;
    const secretValue = crypto.randomUUID();
    const {
      rows: [secret],
    } = await db.query<{ id: string }>(
      `insert into application_secrets(org_id,owner_id,scope,name,value_enc)
     values($1,$2,'personal','APP_TOKEN',$3) returning id`,
      [people.org, people.owner, await encryptSecret(secretValue, launchEncryptionKey)],
    );
    const {
      rows: [actor],
    } = await db.query<{ epoch: number }>("select epoch::int from mcp_actor_epochs where org_id=$1 and user_id=$2", [
      people.org,
      people.owner,
    ]);
    if (scenario !== "sandbox untainted")
      await db.query("update sandboxes set application_secret_tainted=true where id=$1", [id]);
    const manifest = {
      version: 1,
      actorId: people.owner,
      actorEpoch: actor?.epoch ?? 0,
      golden: { id: admission.input.sandbox.goldenId, provider: "modal" },
      account: { id: f.openaiCredentialId, version: 1 },
      definition: {
        provider: "modal",
        harness: "codex",
        model: admission.input.sandbox.model,
        reasoningEffort: admission.input.sandbox.reasoningEffort,
        variables: [],
        secrets: [{ key: "APP_TOKEN", secretId: secret!.id, version: 1 }],
      },
      variables: {},
    };
    await db.query(
      `with template as (
       insert into launch_templates(org_id,owner_id,scope,name)
       values($1,$2,'personal','modal-job-template') returning id
     ), revision as (
       insert into launch_template_revisions(template_id,revision,definition,digest,created_by)
       select id,1,'{}',repeat('a',64),$2 from template returning id,template_id
     )
     insert into template_launch_requests(org_id,actor_id,client_key,digest,template_id,revision_id,
                                          manifest,golden_operation_fence_id,sandbox_id)
     select $1,$2,'first-turn',repeat('a',64),template_id,id,$3,$4,$5 from revision`,
      [people.org, people.owner, manifest, crypto.randomUUID(), id],
    );

    const launch = makeRunner();
    expect(await launch.reconcileOne(signal)).toBe(true);
    await launch.drain();
    const { runtimeToken, epoch } = activeRuntime();
    const bridge = createRuntimeCommands(createRuntimeEnrolments(sql, launchEncryptionKey), launchEncryptionKey);
    const turns = async () =>
      (await db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows;
    const queue = createAccountTurnQueue(sql, launchEncryptionKey);
    const sendFollowUp = () =>
      queue.accept(
        { userId: people.owner, orgs: [{ orgId: people.org, role: "member" }], via: "service" },
        { id, prompt: "Follow up" },
      );
    const firstTurn = (wait: () => Promise<void>) =>
      createJobsRunner(
        createJobsStore(sql, launchEncryptionKey),
        {
          [MODAL_INITIAL_TURN]: createModalInitialTurnJob(
            sql,
            launchEncryptionKey,
            queue,
            createGoldenRuntimeEnvironment(sql, launchEncryptionKey, { now: () => 0, wait }),
            fixtureWorkspaceCommands,
            async () => undefined,
          ),
        },
        () => {},
        () => () => {},
      );

    if (scenario === "secret revoked")
      await db.query("update application_secrets set status='revoked',value_enc=null where id=$1", [secret!.id]);
    const original = firstTurn(async () => {
      throw new Error("Worker lost while waiting for acknowledgement");
    });
    expect(await original.reconcileOne(signal)).toBe(true);
    await original.drain();
    expect(await turns()).toEqual([]);
    if (scenario === "secret revoked" || scenario === "sandbox untainted") {
      expect((await bridge.next(runtimeToken, epoch)).command).toBeNull();
      expect(
        (
          await db.query("select state,outcome->>'reason' as reason from jobs where sandbox_id=$1 and kind=$2", [
            id,
            MODAL_INITIAL_TURN,
          ])
        ).rows,
      ).toEqual([{ state: "failed", reason: "modal_initial_turn_environment_refused" }]);
      if (scenario === "secret revoked") {
        await expect(sendFollowUp()).rejects.toThrow("Modal launch setup failed.");
        const caller = {
          userId: people.owner,
          orgs: [{ orgId: people.org, role: "member" as const }],
          via: "service" as const,
        };
        const jobReader = createModalJobReader(sql, launchEncryptionKey);
        expect(
          await callSharedTool(
            {
              caller,
              data: createSqlData(sql)(caller),
              modalJobReader: (sandbox) => jobReader(sandbox, caller),
              launchCredentials: launchCredentials(createSqlVaultStore(sql), launchEncryptionKey),
              exposedSecrets: async () => [],
              provider: async () => {
                throw new Error("Setup failure must use stored job evidence.");
              },
              now: () => new Date(),
              sleep: async () => {},
            },
            "status",
            { id },
          ),
        ).toMatchObject({
          status: "failed",
          statusReason: "modal_initial_turn_environment_refused",
          settled: true,
          providerState: null,
        });
      }
      return;
    }
    const { command } = await bridge.next(runtimeToken, epoch);
    if (command?.op !== "configureReadableVariables") throw new Error("Missing durable configuration command.");
    expect(command.secretKeys).toEqual(["APP_TOKEN"]);
    expect(command.variables.APP_TOKEN === secretValue).toBe(true);

    await db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN]);
    const replacement = firstTurn(async () => {
      expect(await turns()).toEqual([]);
      expect((await bridge.next(runtimeToken, epoch)).command?.requestId).toBe(command.requestId);
      await bridge.complete(runtimeToken, epoch, {
        epoch,
        requestId: command.requestId,
        status: 200,
        body: { version: 1, requestId: command.requestId, result: { acknowledged: true } },
      });
    });
    expect(await replacement.reconcileOne(signal)).toBe(true);
    await replacement.drain();
    expect(await turns()).toHaveLength(scenario === "promptless takeover" ? 0 : 1);
    expect(
      (await db.query("select state from jobs where sandbox_id=$1 and kind=$2", [id, MODAL_INITIAL_TURN])).rows,
    ).toEqual([{ state: "done" }]);
    expect((await db.query("select request_id from runtime_commands where sandbox_id=$1", [id])).rows).toEqual([
      { request_id: command.requestId },
    ]);
    if (scenario === "acknowledgement lost") {
      const [initial] = await turns();
      const followUp = await sendFollowUp();
      const { rows } = await db.query(
        "select request_id from account_turn_queue where sandbox_id=$1 order by sequence",
        [id],
      );
      expect(rows).toEqual([initial, { request_id: followUp.requestId }]);
    }
  },
);

test.each(["without current enrolment", "after stop"] as const)(
  "the registered Modal first-turn job declines a completed launch %s",
  async (target) => {
    const { f, id, makeRunner } = await modalLaunchFixture(await modalAdmissionFixture());
    const launch = makeRunner();
    expect(await launch.reconcileOne(signal)).toBe(true);
    await launch.drain();
    if (target === "after stop") {
      await f.db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [id]);
    } else {
      await f.db.query("delete from runtime_enrolments where sandbox_id=$1", [id]);
    }
    const firstTurn = await modalFirstTurnLane(f, createAccountTurnQueue(f.sql, launchEncryptionKey));
    expect(await firstTurn.reconcileOne(signal)).toBe(true);
    await firstTurn.drain();
    expect((await f.db.query("select request_id from account_turn_queue where sandbox_id=$1", [id])).rows).toEqual([]);
    expect(
      (await f.db.query("select state from jobs where sandbox_id=$1 and kind='launch_initial_turn'", [id])).rows,
    ).toEqual([{ state: "failed" }]);
  },
);

test.each(["create response", "bootstrap dispatch"] as const)(
  "an expired Modal launch hands off the exact allocation after losing the %s",
  async (failure) => {
    const { f, id, jobId, makeRunner, hideAllocation, revealAllocation, effects, cleanupEffects, closedClients } =
      await modalLaunchFixture();
    const first = makeRunner((step) => {
      if (step === failure) throw new Error("Lost worker");
    });
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    await f.db.query("update jobs set lease_until='-infinity', deadline_at='-infinity' where id=$1", [jobId]);
    const successor = makeRunner();
    if (failure === "create response") {
      hideAllocation();
      expect(await successor.reconcileOne(signal)).toBe(true);
      await successor.drain();
      expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([
        { status: "starting" },
      ]);
      expect((await f.db.query("select state from jobs where sandbox_id=$1", [id])).rows).toEqual([
        { state: "queued" },
      ]);
      await f.db.query("update jobs set run_after='-infinity', deadline_at='infinity' where id=$1", [jobId]);
      revealAllocation();
    }
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual([]);
    expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "failed" }]);
    const {
      rows: [cleanup],
    } = await f.db.query<{ id: string }>("select id from jobs where kind='delete' and sandbox_id=$1", [id]);
    expect(cleanup).toBeDefined();
    const lifecycle = createSandboxLifecycle(f.sql, async () => {
      throw new Error("Failed launch cleanup must use the job-owned allocation.");
    });
    await f.db.query("update sandboxes set reconcile_after='-infinity' where id=$1", [id]);
    expect(await lifecycle.reconcileOne()).toBe(false);
    const lost = makeRunner((step) => {
      if (step === "termination response") throw new Error("Worker lost the termination response");
    });
    expect(await lost.reconcileOne(signal)).toBe(true);
    await lost.drain();
    expect(closedClients()).toBe(1);
    expect((await f.db.query("select state from jobs where id=$1", [cleanup!.id])).rows).toEqual([{ state: "leased" }]);
    await f.db.query("update jobs set lease_until='-infinity' where id=$1", [cleanup!.id]);

    if (failure === "bootstrap dispatch") {
      await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [cleanup!.id]);
    }
    expect(await lifecycle.reconcileOne()).toBe(false);
    const cleanupSuccessor = makeRunner();
    expect(await cleanupSuccessor.reconcileOne(signal)).toBe(true);
    await cleanupSuccessor.drain();
    expect(closedClients()).toBe(2);
    expect((await f.db.query("select state from jobs where id=$1", [cleanup!.id])).rows).toEqual([{ state: "done" }]);
    expect(cleanupEffects().terminations).toBe(1);
    expect(await lifecycle.reconcileOne()).toBe(false);
  },
);

test.each(["deleting", "deleted"] as const)(
  "Modal cleanup resumes after a crash at the durable %s checkpoint",
  async (phase) => {
    const { f, id, jobId, makeRunner, cleanupEffects } = await modalLaunchFixture();
    const launch = makeRunner((step) => {
      if (step === "create response") throw new Error("Lost create response");
    });
    expect(await launch.reconcileOne(signal)).toBe(true);
    await launch.drain();
    await f.db.query("update jobs set lease_until='-infinity', deadline_at='-infinity' where id=$1", [jobId]);
    const failure = makeRunner();
    expect(await failure.reconcileOne(signal)).toBe(true);
    await failure.drain();

    const crashAfterCheckpoint: Sql = {
      ...f.sql,
      async transaction(work) {
        let checkpointWritten = false;
        const result = await f.sql.transaction!(async (tx) =>
          work({
            ...tx,
            async query<T>(query: string, params?: unknown[]) {
              const result = await tx.query<T>(query, params);
              if (query.includes("set outcome=jsonb_set") && typeof params?.[1] === "string") {
                checkpointWritten = result.rows.length > 0 && JSON.parse(params[1]).entry.phase === phase;
              }
              return result;
            },
          }),
        );
        if (checkpointWritten) throw new Error("Lost journal commit acknowledgement");
        return result;
      },
    };
    const lost = makeRunner(undefined, crashAfterCheckpoint);
    expect(await lost.reconcileOne(signal)).toBe(true);
    await lost.drain();
    expect(
      (
        await f.db.query("select outcome #>> '{evidence,modal_machine,entry,phase}' as phase from jobs where id=$1", [
          jobId,
        ])
      ).rows,
    ).toEqual([{ phase }]);
    expect(cleanupEffects().terminations).toBe(phase === "deleted" ? 1 : 0);
    await f.db.query("update jobs set lease_until='-infinity' where kind='delete' and sandbox_id=$1", [id]);
    if (phase === "deleted") {
      await f.db.query("update jobs set deadline_at='-infinity' where kind='delete' and sandbox_id=$1", [id]);
    }
    const successor = makeRunner((step) => {
      if (phase === "deleted" && step === "cleanup preparation") throw new Error("Modal credentials unavailable");
    });
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    expect((await f.db.query("select state from jobs where kind='delete' and sandbox_id=$1", [id])).rows).toEqual([
      { state: "done" },
    ]);
    expect(cleanupEffects().terminations).toBe(1);
    expect(cleanupEffects().cleanupPreparations).toBe(phase === "deleted" ? 1 : 2);
  },
);

test("owner stop retains the original machine after job-owned Modal bootstrap takeover", async () => {
  const { f, id, jobId, makeRunner, effects, retentionEffects, cleanupEffects, retentionHost } =
    await modalLaunchFixture(await modalAdmissionFixture());
  const first = makeRunner((step) => {
    if (step === "bootstrap dispatch") throw new Error("Worker lost after issuing the ticket");
  });
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();

  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const data = createSqlData(f.sql)(caller);
  await f.db.query(
    `insert into runtime_checkpoints (sandbox_id,epoch,request_id,watermark,completed_at)
     select sandbox_id,epoch,$2,0,now() from runtime_enrolments where sandbox_id=$1`,
    [id, crypto.randomUUID()],
  );
  const commands = createRuntimeCommands(createRuntimeEnrolments(f.sql, launchEncryptionKey), launchEncryptionKey);
  const checkpoint = createRuntimeCheckpoint(f.sql, launchEncryptionKey, commands);
  const serving = createRuntimeServing(f.sql, launchEncryptionKey);
  const host = retentionHost();
  const stop = (target: Parameters<typeof serving>[1]) =>
    serving(host.provider, target, caller, host.captureRuntimeWork);
  const jobReader = createModalJobReader(f.sql, launchEncryptionKey);
  expect(
    await callSharedTool(
      {
        caller,
        data,
        launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
        exposedSecrets: async () => [],
        provider: stop,
        runtimeStopCheckpoint: createRuntimeStopCheckpoint(f.sql, checkpoint),
        now: () => new Date(),
        async sleep() {
          throw new Error("Stop must not wait");
        },
      },
      "stop",
      { id },
    ),
  ).toMatchObject({ id, status: "stopping" });
  const stopRunner = createJobsRunner(createJobsStore(f.sql, launchEncryptionKey), {
    stop: createStopJob(f.sql, launchEncryptionKey, undefined, Date.now, async () => {
      const target = await data.sandboxes.get(id);
      if (!target) throw new Error("Stop target disappeared.");
      return stop(target);
    }),
  });
  expect(await stopRunner.reconcileOne(signal)).toBe(true);
  await stopRunner.drain();
  const statusContext = {
    caller,
    data,
    launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
    exposedSecrets: async () => [],
    modalJobReader: (sandbox) => jobReader(sandbox, caller),
    async provider() {
      throw new Error("Status must use the durable stop evidence without a provider client");
    },
    now: () => new Date(),
    async sleep() {
      throw new Error("Confirmed stop must settle without waiting");
    },
  } satisfies Parameters<typeof callSharedTool>[0];
  expect(await callSharedTool(statusContext, "status", { id })).toMatchObject({
    id,
    status: "stopped",
    providerState: "stopped",
    settled: true,
  });
  expect(effects()).toMatchObject({ allocations: 1, bootstrapped: ["physical"] });
  expect(retentionEffects()).toEqual({ checkpoints: 1, baselineCaptures: 1 });
  expect(cleanupEffects().terminations).toBe(1);
  const { rows } = await f.db.query(
    "select record->>'recoveryImageId' as image from modal_machines where id='physical'",
  );
  expect(rows).toEqual([{ image: "im-retained" }]);
});

test.each(["dispatch deadline", "lease takeover"] as const)(
  "Modal retained stop handles a pending snapshot receipt across %s",
  async (boundary) => {
    const f = await fixture();
    const recordId = "retained-placement";
    const physicalId = "retained-machine";
    const recoveryImageId = "recovery-image";
    const checkpoint = { epoch: "1", watermark: 0 };
    const id = await unboundModalSandbox(f, recordId);
    const scope = {
      orgId: f.people.org,
      userId: f.people.owner,
      visibility: "private" as const,
      binding: { workspace: "workspace", environment: "main", appId: "ap-test" },
    };
    const journal = createSqlModalStore(f.sql, scope);
    await f.db.query(`update sandboxes set status='stopping',stop_requested_at=now() where id=$1`, [id]);
    await f.db.query("insert into runtime_enrolments(sandbox_id,lifecycle_generation,epoch) values($1,2,1)", [id]);
    await f.db.query(
      `insert into runtime_checkpoints (sandbox_id,epoch,request_id,watermark,completed_at)
       values ($1,1,$2,0,now())`,
      [id, crypto.randomUUID()],
    );
    await f.db.query(
      `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
       values($1,$2,$3,'private',$4,$4,$5)`,
      [
        scopeKey(scope),
        f.people.org,
        f.people.owner,
        recordId,
        {
          info: { id: recordId, state: "ready" },
          generation: 2,
          commonRuntime: true,
          phase: "active",
          physicalId,
          imageId: "initial-image",
        },
      ],
    );
    const deadline = new Date("2099-01-01T00:00:00Z");
    const now = () => deadline.getTime() - 60_000;
    const jobId = await f.store.enqueue("stop", id, 2, id, null, {
      orgId: f.people.org,
      deadline,
      maxAttempts: 3,
    });
    await f.db.query("update jobs set outcome=$2 where id=$1", [jobId, { modal_capture_complete: true }]);

    const releaseSuccessor = Promise.withResolvers<void>();
    let snapshots = 0;
    let terminations = 0;
    let exited = false;
    let observationUnavailable = false;
    const resumeImages: string[] = [];
    const stopCompute = {
      sandboxId: physicalId,
      async poll() {
        if (observationUnavailable) throw new Error("Modal exit observation was interrupted");
        return exited ? 0 : null;
      },
      async terminate() {
        terminations++;
        exited = true;
      },
      async snapshotFilesystem() {
        snapshots++;
        const image = { imageId: recoveryImageId };
        if (snapshots === 1) {
          if (boundary === "dispatch deadline") {
            await f.db.query("update jobs set deadline_at='2000-01-01' where id=$1", [jobId]);
            observationUnavailable = true;
          } else {
            await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
            await successor.reconcileOne(signal);
          }
        }
        return image;
      },
    };
    const replacement = { sandboxId: "replacement", poll: async () => null };
    const { provider } = createModalProvider({
      appName: "test",
      client: {
        apps: { fromName: async () => ({ appId: "ap-test" }) },
        images: { fromId: async (imageId: string) => ({ imageId }) },
        volumes: { fromName: async () => ({ withMountOptions: () => ({}) }) },
        sandboxes: {
          fromId: async (machineId: string) => (machineId === physicalId ? stopCompute : replacement),
          create: async (_app: unknown, image: { imageId: string }) => {
            resumeImages.push(image.imageId);
            return replacement;
          },
        },
      } as unknown as NonNullable<Parameters<typeof createModalProvider>[0]["client"]>,
      scope,
      store: journal,
      distribution: {
        capabilities: {},
        async image() {
          throw new Error("Resume must use the retained image");
        },
        prepareSnapshot: async () => {},
      },
    });
    const runner = (resolve = async () => provider) =>
      createJobsRunner(
        f.store,
        { stop: createStopJob(f.sql, launchEncryptionKey, undefined, now, resolve) },
        () => {},
        () => () => {},
      );
    const first = runner();
    const successor = runner(async () => {
      if (boundary === "lease takeover") await releaseSuccessor.promise;
      return provider;
    });
    const readJob = async () =>
      (
        await f.db.query<{ state: string; lease_epoch: string; outcome: { modal_checkpoint: typeof checkpoint } }>(
          "select state,lease_epoch::text,outcome from jobs where id=$1",
          [jobId],
        )
      ).rows[0]!;
    const readSandbox = async () =>
      (await f.db.query("select status,stopped_at from sandboxes where id=$1", [id])).rows;

    try {
      expect(await first.reconcileOne(signal)).toBe(true);
      await first.drain();
      expect(snapshots).toBe(1);
      expect(await readSandbox()).toEqual([{ status: "stopping", stopped_at: null }]);

      if (boundary === "lease takeover") {
        expect(await readJob()).toMatchObject({ state: "leased", lease_epoch: "2" });
        const ambiguous = await journal.get(recordId);
        expect(ambiguous.phase).toBe("snapshot");
        expect(ambiguous.recoveryImageId).toBeUndefined();
        releaseSuccessor.resolve();
        await successor.drain();
        expect(await journal.get(recordId)).toEqual(ambiguous);
        expect(await readSandbox()).toEqual([{ status: "stopping", stopped_at: null }]);
        expect(await readJob()).toMatchObject({ state: "queued", lease_epoch: "2" });
      } else {
        expect(await readJob()).toMatchObject({ state: "queued", lease_epoch: "1" });
        expect(await journal.get(recordId)).toMatchObject({
          phase: "terminate",
          recoveryImageId,
          runtimeCheckpoint: { ...checkpoint, generation: 2, physicalId },
        });
        observationUnavailable = false;
        const reconcile = async () => {
          await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
          expect(await successor.reconcileOne(signal)).toBe(true);
          await successor.drain();
        };
        await reconcile();
        expect(terminations).toBe(0);
        expect(await readJob()).toMatchObject({ state: "queued" });
        exited = true;
        await reconcile();
        const stopped = await readJob();
        expect(stopped).toMatchObject({ state: "done", outcome: { modal_checkpoint: checkpoint } });
        expect(await readSandbox()).toMatchObject([{ status: "stopped", stopped_at: expect.any(Date) }]);
        const resume = await provider.runtimeResumeMachine({
          recordId,
          sandboxId: id,
          generation: 3,
          checkpoint: stopped.outcome.modal_checkpoint,
          deadlineAt: deadline.getTime(),
          write: (work) => f.sql.transaction!(work),
          authorize: async () => {},
          ticket: async () => null,
        });
        expect(
          await resume.resume({
            sandboxId: id,
            generation: 3,
            predecessor: resume.predecessor,
            computeTtlSeconds: 60,
            size: null,
            signal,
          }),
        ).toMatchObject({ machineId: replacement.sandboxId });
        expect(resumeImages).toEqual([recoveryImageId]);
        expect(await journal.get(recordId)).toMatchObject({
          runtimeCheckpoint: { ...checkpoint, generation: 2, physicalId },
        });
      }
      expect(snapshots).toBe(1);
      expect(terminations).toBe(0);
    } finally {
      releaseSuccessor.resolve();
      await successor.drain();
    }
  },
);

test.each(["lost allocation", "enrolled replacement"] as const)(
  "owner stop settles the exact previous Modal resume generation after %s",
  async (state) => {
    const f = await fixture();
    const recordId = "retained-placement";
    const id = await unboundModalSandbox(f, recordId);
    const scope = {
      orgId: f.people.org,
      userId: f.people.owner,
      visibility: "private" as const,
      binding: { workspace: "workspace", environment: "main", appId: "ap-test" },
    };
    const replacementId = "replacement";
    const epoch = state === "lost allocation" ? 1 : 2;
    await f.db.query("update sandboxes set expires_at=clock_timestamp()+interval '1 hour' where id=$1", [id]);
    await f.db.query("insert into runtime_enrolments(sandbox_id,lifecycle_generation,epoch) values($1,2,$2)", [
      id,
      epoch,
    ]);
    await f.db.query(
      `insert into runtime_checkpoints (sandbox_id,epoch,request_id,watermark,completed_at)
       values ($1,1,$2,0,now())`,
      [id, crypto.randomUUID()],
    );
    const resume = await f.store.enqueue("resume", id, 2, "restore", null, {
      orgId: f.people.org,
      maxAttempts: 3,
      deadline: new Date("2100-01-01T00:00:00Z"),
    });
    const proof = { checkpoint: { epoch: "1", target: "2", watermark: 0 } };
    await f.db.query("update jobs set outcome=$2,state=$3 where id=$1", [
      resume,
      state === "lost allocation" ? proof : { reason: "resume_dispatch_ended", evidence: proof },
      state === "lost allocation" ? "queued" : "failed",
    ]);
    await f.db.query(
      `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
       values($1,$2,$3,'private',$4,$4,$5)`,
      [
        scopeKey(scope),
        f.people.org,
        f.people.owner,
        recordId,
        {
          info: { id: recordId, state: "starting" },
          generation: 2,
          runtimeResumeGeneration: 2,
          commonRuntime: true,
          phase: state === "lost allocation" ? "creating" : "active",
          physicalName: "replacement-name",
          ...(state === "enrolled replacement" && { physicalId: replacementId }),
          imageId: "retained-image",
          recoveryImageId: "retained-image",
          runtimeCheckpoint: { epoch: "1", watermark: 0, generation: 1, physicalId: "retained-machine" },
        },
      ],
    );
    const caller: Caller = {
      via: "service",
      userId: f.people.owner,
      orgs: [{ orgId: f.people.org, role: "member" }],
    };
    const data = createSqlData(f.sql)(caller);
    const unexpected = async () => {
      throw new Error("Stop must not dispatch compute in this phase");
    };
    expect(
      await callSharedTool(
        {
          caller,
          data,
          launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
          exposedSecrets: async () => [],
          provider: unexpected,
          now: () => new Date(),
          sleep: unexpected,
        },
        "stop",
        { id },
      ),
    ).toEqual({ id, status: "stopping" });
    await f.db.query("update jobs set deadline_at='-infinity' where sandbox_id=$1 and kind='stop'", [id]);
    const replacement = {
      sandboxId: replacementId,
      async getTags() {
        return { armada_sandbox: recordId, armada_scope: scopeKey(scope), armada_generation: "2" };
      },
      async poll() {
        return 0;
      },
      terminate: unexpected,
    };
    const { provider } = createModalProvider({
      appName: "test",
      client: {
        apps: {
          async fromName() {
            return { appId: "ap-test" };
          },
        },
        sandboxes: {
          async fromName(_app: string, name: string) {
            expect(name).toBe("replacement-name");
            return replacement;
          },
          async fromId(machineId: string) {
            expect(machineId).toBe(replacementId);
            return replacement;
          },
        },
      } as unknown as NonNullable<Parameters<typeof createModalProvider>[0]["client"]>,
      scope,
      store: createSqlModalStore(f.sql, scope),
      distribution: { capabilities: {}, image: unexpected, prepareSnapshot: unexpected },
    });
    const stopRunner = createJobsRunner(f.store, {
      stop: createStopJob(f.sql, launchEncryptionKey, undefined, Date.now, async () => provider),
    });
    expect(await stopRunner.reconcileOne(signal)).toBe(true);
    await stopRunner.drain();
    expect(await data.sandboxes.get(id)).toMatchObject({ lifecycleGeneration: 3, status: "stopped" });
    expect(
      (
        await f.db.query("select outcome->'modal_checkpoint' as proof from jobs where sandbox_id=$1 and kind='stop'", [
          id,
        ])
      ).rows,
    ).toEqual([{ proof: { epoch: "1", watermark: 0 } }]);
    expect(await createSqlModalStore(f.sql, scope).get(recordId)).toMatchObject({
      phase: "stopped",
      recoveryImageId: "retained-image",
      runtimeCheckpoint: { epoch: "1", watermark: 0, generation: 2, physicalId: replacementId },
    });
  },
);

test("owner stop after a lost Modal create reply leaves the exact allocation for replacement cleanup", async () => {
  const { f, id, jobId, makeRunner, effects, cleanupEffects, hideAllocation } = await modalLaunchFixture(
    await modalAdmissionFixture(),
  );
  const interrupted = makeRunner((step) => {
    if (step === "create response") throw new Error("Lost create response");
  });
  expect(await interrupted.reconcileOne(signal)).toBe(true);
  await interrupted.drain();

  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const data = createSqlData(f.sql)(caller);
  const context = {
    caller,
    data,
    launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
    exposedSecrets: async () => [],
    async provider() {
      throw new Error("Owner stop must not resolve the synchronous provider");
    },
    now: () => new Date("2026-11-21T00:00:00Z"),
    async sleep() {
      throw new Error("Owner stop must return without waiting for cleanup");
    },
  } satisfies Parameters<typeof callSharedTool>[0];
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  let observed = false;
  let stopAccepted = false;
  const beforeSettlement: Sql = {
    ...f.sql,
    async transaction(work) {
      let checkedDispatchAfterObservation = false;
      const result = await f.sql.transaction!((tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            if (query.includes("select public.complete_job")) throw new Error("Worker lost before failure settlement");
            if (observed && query.includes("select s.provider_sandbox_id") && query.includes("for share of m"))
              checkedDispatchAfterObservation = true;
            return tx.query<T>(query, params);
          },
        }),
      );
      if (checkedDispatchAfterObservation && !stopAccepted) {
        expect(await callSharedTool(context, "stop", { id })).toEqual({ id, status: "starting" });
        stopAccepted = true;
      }
      return result;
    },
  };
  const recovering = makeRunner((step) => {
    if (step === "machine poll") {
      hideAllocation();
      observed = true;
    }
  }, beforeSettlement);
  expect(await recovering.reconcileOne(signal)).toBe(true);
  await recovering.drain();
  expect(stopAccepted).toBe(true);
  expect(cleanupEffects().terminations).toBe(0);
  const stopped = await data.sandboxes.get(id);
  expect(stopped?.status).toBe("starting");
  expect(stopped?.stopRequestedAt).toBeTruthy();
  expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "leased" }]);

  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(await callSharedTool(context, "stop", { id })).toEqual({ id, status: "failed" });
  expect((await data.sandboxes.get(id))?.lifecycleGeneration).toBe(stopped?.lifecycleGeneration);
  await expect(data.sandboxes.assertDeletionAllowed!(id)).rejects.toMatchObject({ code: "conflict" });
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();

  expect(effects()).toMatchObject({ allocations: 1, bootstrapped: [] });
  expect(cleanupEffects().terminations).toBe(1);
  expect((await f.db.query("select state from jobs where sandbox_id=$1 and kind='delete'", [id])).rows).toEqual([
    { state: "done" },
  ]);
});

test("status and wait return a failed Modal launch receipt before provider identity exists", async () => {
  const { f, id, jobId, makeRunner } = await modalLaunchFixture(await modalAdmissionFixture());
  await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const unexpectedProvider = async () => {
    throw new Error("Provider lookup requires a bound machine");
  };
  const context = {
    caller,
    data: createSqlData(f.sql)(caller),
    launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
    exposedSecrets: async () => [],
    provider: unexpectedProvider,
    storedProviders: { modal: unexpectedProvider },
    modalJobReader: (sandbox) => createModalJobReader(f.sql, launchEncryptionKey)(sandbox, caller),
    now: () => new Date("2026-11-21T00:00:00Z"),
    sleep: async () => {
      throw new Error("A failed launch must settle immediately");
    },
  } satisfies Parameters<typeof callSharedTool>[0];

  for (const action of ["status", "wait"]) {
    expect(await callSharedTool(context, action, { id })).toMatchObject({
      id,
      status: "failed",
      statusReason: "modal_launch_failed",
      providerState: null,
      prompt: null,
      settled: true,
    });
  }
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(await callSharedTool(context, "wait", { id })).toMatchObject({
    id,
    status: "failed",
    providerState: "stopped",
    settled: true,
  });
  await expect(
    callSharedTool(context, "report", { id, prompt_id: "missing", outcome: { state: "ready" } }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("REST and MCP read job-owned Modal logs from the runtime journal without a provider", async () => {
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(await modalAdmissionFixture());
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();

  const { runtimeToken, epoch } = activeRuntime();
  await createRuntimeEvents(createRuntimeEnrolments(f.sql, launchEncryptionKey), launchEncryptionKey).append(
    runtimeToken,
    epoch,
    {
      sandboxId: id,
      generation: epoch,
      events: [
        {
          sequence: 1,
          event: { id: "journal", at: 1, kind: "message", text: "Job-owned output", partial: false, tools: [] },
        },
      ],
    },
  );
  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const data = createSqlData(f.sql)(caller);
  const resolveProvider = async () => {
    throw new Error("A job-owned log read must not resolve a Modal provider.");
  };
  const resolveLogs = createModalLogReader(f.sql, launchEncryptionKey, resolveProvider);
  const result = { source: "armada-runtime", events: [{ text: "Job-owned output" }] };
  expect(
    await readLogs(
      {
        logs: async (actor, id) => {
          const sandbox = (await data.sandboxes.get(id))!;
          return { provider: await resolveLogs(sandbox, actor), providerSandboxId: sandbox.providerSandboxId };
        },
      },
      caller,
      id,
      {},
    ),
  ).toMatchObject(result);
  expect(
    await callSharedTool(
      {
        caller,
        data,
        launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
        exposedSecrets: async () => [],
        provider: resolveProvider,
        logProvider: (sandbox) => resolveLogs(sandbox, caller),
        now: () => new Date(),
        sleep: async () => {
          throw new Error("Logs must not wait.");
        },
      },
      "logs",
      { id },
    ),
  ).toMatchObject(result);
});

test("enrolled Modal launch jobs report and settle turns from the runtime journal", async () => {
  const admission = await modalAdmissionFixture();
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(admission);
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();

  const { runtimeToken, epoch } = activeRuntime();
  const promptId = crypto.randomUUID();
  const queue = createAccountTurnQueue(f.sql, launchEncryptionKey);
  const journal = createRuntimeEvents(createRuntimeEnrolments(f.sql, launchEncryptionKey), launchEncryptionKey);
  const append = (sequence: number, status: "running" | "finished") =>
    journal.append(runtimeToken, epoch, {
      sandboxId: id,
      generation: epoch,
      events: [
        { sequence, event: { id: `turn-${sequence}`, at: sequence, kind: "prompt", text: "work", promptId, status } },
      ],
    });
  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const data = createSqlData(f.sql)(caller);
  const unavailable = async () => {
    throw new Error("The legacy Modal provider has no record of this launch job.");
  };
  const jobReader = createModalJobReader(f.sql, launchEncryptionKey);
  const logReader = createModalLogReader(f.sql, launchEncryptionKey, unavailable);
  const context = {
    caller,
    data,
    accountTurns: queue,
    launchCredentials: launchCredentials(createSqlVaultStore(f.sql), launchEncryptionKey),
    exposedSecrets: async () => [],
    provider: unavailable,
    storedProviders: { modal: unavailable },
    modalJobReader: (sandbox) => jobReader(sandbox, caller),
    now: () => new Date("2026-11-21T00:00:00Z"),
    sleep: async () => {
      throw new Error("A finished turn must settle immediately.");
    },
  } satisfies Parameters<typeof callSharedTool>[0];
  const follow = (
    cursor?: string,
    hooks?: { beforePage?: () => Promise<unknown>; afterPage?: () => Promise<unknown> },
  ) =>
    readLogs(
      {
        logs: async (actor, id) => {
          const sandbox = (await data.sandboxes.get(id))!;
          const provider = await logReader(sandbox, actor);
          return {
            provider: {
              ...provider,
              async events(request) {
                await hooks?.beforePage?.();
                const page = await provider.events(request);
                await hooks?.afterPage?.();
                return page;
              },
            },
            providerSandboxId: sandbox.providerSandboxId,
          };
        },
      },
      caller,
      id,
      { follow: true, ...(cursor ? { cursor } : {}) },
    );
  expect(await callSharedTool(context, "status", { id })).toMatchObject({
    status: "starting",
    prompt: null,
    settled: false,
    statusMessage: "Modal launch setup is still in progress.",
  });
  expect(await callSharedTool(context, "status", { id, recorded: true })).toMatchObject({ status: "starting" });
  const followup = { id, request_id: crypto.randomUUID(), prompt: "Follow up during setup" };
  expect(await callSharedTool(context, "send", followup)).toMatchObject({ status: "queued" });
  expect(await callSharedTool(context, "status", { id, prompt_id: followup.request_id })).toMatchObject({
    status: "starting",
    settled: false,
    prompt: { promptId: followup.request_id, state: "running" },
  });
  await f.db.query("delete from account_turn_queue where request_id=$1", [followup.request_id]);
  const { input } = admission;
  const actor = { orgId: input.orgId, userId: input.ownerId, role: "member" as const };
  expect(await replayModalLaunch(f.sql, actor, input.sandbox.goldenId, input.request!)).toEqual({
    sandbox: { id, status: "starting" },
  });
  expect(await data.sandboxes.list({ limit: 10, statuses: ["ready"] })).toMatchObject({ total: 0 });
  expect(await data.sandboxes.list({ limit: 10, statuses: ["starting"] })).toMatchObject({
    total: 1,
    rows: [{ id, status: "starting" }],
  });
  expect(await follow()).toMatchObject({ settled: false });

  const setup = await modalFirstTurnLane(f, queue);
  const snapshotThenEnqueue = {
    ...queue,
    async status(...args: Parameters<typeof queue.status>) {
      const snapshot = await queue.status(...args);
      expect(await setup.reconcileOne(signal)).toBe(true);
      await setup.drain();
      return snapshot;
    },
  };
  expect(await callSharedTool({ ...context, accountTurns: snapshotThenEnqueue }, "status", { id })).toMatchObject({
    status: "ready",
    settled: false,
  });
  const {
    rows: [turn],
  } = await f.db.query<{ request_id: string }>("select request_id from account_turn_queue where sandbox_id=$1", [id]);
  const publicPromptId = turn!.request_id;
  await f.db.query("update sandboxes set task_prompt_id=$2 where id=$1", [id, promptId]);
  await f.db.query("update account_turn_queue set state='admitted',result_enc=$2 where sandbox_id=$1", [
    id,
    await encryptSecret(JSON.stringify({ promptId }), launchEncryptionKey),
  ]);
  expect(await callSharedTool(context, "status", { id, prompt_id: publicPromptId })).toMatchObject({
    prompt: { promptId: publicPromptId, state: "running" },
    settled: false,
  });
  const report = () =>
    callSharedTool(context, "report", { id, prompt_id: publicPromptId, outcome: { state: "ready" } });

  await append(1, "running");
  expect(await callSharedTool(context, "status", { id })).toMatchObject({
    id,
    providerState: null,
    prompt: { promptId: publicPromptId, state: "running" },
    settled: false,
  });
  const active = await follow();
  expect(active.settled).toBe(false);
  expect(active.cursor).not.toBeNull();
  expect(await follow(active.cursor!)).toMatchObject({ events: [], settled: false });
  await expect(report()).rejects.toMatchObject({ code: "conflict" });

  expect(await follow(active.cursor!, { afterPage: () => append(2, "finished") })).toMatchObject({
    events: [],
    settled: false,
  });
  expect(await callSharedTool(context, "wait", { id, prompt_id: publicPromptId })).toMatchObject({
    id,
    providerState: null,
    prompt: { promptId: publicPromptId, state: "finished" },
    settled: true,
  });
  expect(await follow(active.cursor!)).toMatchObject({ events: [{ status: "finished" }], settled: true });
  expect(await report()).toMatchObject({ id, taskOutcome: { state: "ready" } });

  await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
  expect(await callSharedTool(context, "wait", { id, prompt_id: publicPromptId })).toMatchObject({
    id,
    providerState: null,
    prompt: { promptId: publicPromptId, state: "finished" },
    settled: true,
  });
  expect(await follow(active.cursor!)).toMatchObject({ events: [{ status: "finished" }], settled: true });
  await expect(
    follow(active.cursor!, {
      beforePage: () =>
        f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("Modal read ownership survives a generation advance before the launch receipt settles", async () => {
  const { f, id, jobId, makeRunner } = await modalLaunchFixture(await modalAdmissionFixture());
  const runner = makeRunner(async (step) => {
    if (step !== "bootstrap response") return;
    await f.db.query("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [id]);
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).not.toEqual([{ state: "done" }]);

  const caller = {
    via: "service" as const,
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" as const }],
  };
  const sandbox = (await createSqlData(f.sql)(caller).sandboxes.get(id))!;
  expect(sandbox.status).toBe("ready");
  const reader = await createModalJobReader(f.sql, launchEncryptionKey)(sandbox, caller);
  expect(await reader?.followSettled()).toBe(true);
});

async function failedModalLaunchFixture() {
  const fixture = await modalLaunchFixture();
  const { f, jobId, makeRunner } = fixture;
  const launch = makeRunner((step) => {
    if (step === "bootstrap dispatch") throw new Error("Lost bootstrap response");
  });
  expect(await launch.reconcileOne(signal)).toBe(true);
  await launch.drain();
  await f.db.query("update jobs set lease_until='-infinity', deadline_at='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  return fixture;
}

test("a replacement Modal cleanup claimant unblocks owner deletion after confirming exit", async () => {
  const { f, id, makeRunner, cleanupEffects } = await failedModalLaunchFixture();
  const data = createSqlData(f.sql)({
    via: "service",
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" }],
  });
  const remove = () =>
    deleteSandboxWithActivity(
      data.sandboxes,
      {
        async resolve() {
          throw new Error("A failed launch with confirmed exit needs no provider client.");
        },
      },
      id,
    );
  await expect(remove()).rejects.toMatchObject({ code: "conflict", message: "Sandbox exit is unconfirmed." });

  const initial = makeRunner((step) => {
    if (step === "cleanup preparation") throw new Error("Modal credentials temporarily unavailable.");
  });
  expect(await initial.reconcileOne(signal)).toBe(true);
  await initial.drain();
  expect(cleanupEffects()).toEqual({ terminations: 0, cleanupPreparations: 1 });
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind='delete'", [id]);
  const interruptedCompletion: Sql = {
    ...f.sql,
    transaction: (work) =>
      f.sql.transaction!(async (tx) => {
        let completed = false;
        const result = await work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            const result = await tx.query<T>(query, params);
            if (query.includes("public.complete_job") && params?.[4] === "done") completed = true;
            return result;
          },
        });
        if (completed) throw new Error("Worker lost before cleanup commit");
        return result;
      }),
  };
  const interrupted = makeRunner(undefined, interruptedCompletion);
  expect(await interrupted.reconcileOne(signal)).toBe(true);
  await interrupted.drain();
  expect(cleanupEffects()).toEqual({ terminations: 1, cleanupPreparations: 2 });
  await expect(remove()).rejects.toMatchObject({ code: "conflict", message: "Sandbox exit is unconfirmed." });

  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind='delete'", [id]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(cleanupEffects()).toEqual({ terminations: 1, cleanupPreparations: 2 });
  expect((await f.db.query("select state from jobs where sandbox_id=$1 and kind='delete'", [id])).rows).toEqual([
    { state: "done" },
  ]);
  expect(await remove()).toEqual({ id, status: "deleted" });
});

test("Modal cleanup does not use another user's registered App credentials", async () => {
  const { f, id, makeRunner, cleanupEffects } = await failedModalLaunchFixture();
  await f.db.query("update modal_server_apps set authority_owner_id=$1 where org_id=$1", [f.people.org]);
  await f.db.query("update jobs set deadline_at='-infinity' where sandbox_id=$1 and kind='delete'", [id]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(cleanupEffects()).toEqual({ terminations: 0, cleanupPreparations: 0 });
  expect(
    (
      await f.db.query("select state, outcome->>'reason' as reason from jobs where sandbox_id=$1 and kind='delete'", [
        id,
      ])
    ).rows,
  ).toEqual([{ state: "failed", reason: "modal_launch_cleanup_unconfirmed" }]);
});

test("Modal cleanup does not terminate when its budget expires during the running poll", async () => {
  const { f, id, makeRunner, cleanupEffects } = await failedModalLaunchFixture();
  const cleanup = makeRunner(async (step) => {
    if (step === "machine poll") {
      await f.db.query("update jobs set deadline_at='-infinity' where kind='delete' and sandbox_id=$1", [id]);
    }
  });
  expect(await cleanup.reconcileOne(signal)).toBe(true);
  await cleanup.drain();
  expect(
    (
      await f.db.query("select state, outcome->>'reason' as reason from jobs where kind='delete' and sandbox_id=$1", [
        id,
      ])
    ).rows,
  ).toEqual([{ state: "failed", reason: "modal_launch_cleanup_unconfirmed" }]);
  expect(cleanupEffects().terminations).toBe(0);
});

test("an interrupted Modal failure handoff rolls back the failure and delete job together", async () => {
  const { f, id, jobId, makeRunner, cleanupEffects } = await modalLaunchFixture();
  await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
  const interrupted: Sql = {
    ...f.sql,
    transaction: (work) =>
      f.sql.transaction!(async (tx) => {
        let inserted = false;
        const result = await work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            const result = await tx.query<T>(query, params);
            if (params?.[0] === "delete" && query.includes("insert into public.jobs")) inserted = true;
            return result;
          },
        });
        if (inserted) throw new Error("Worker lost before commit");
        return result;
      }),
  };
  const first = makeRunner(undefined, interrupted);
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "starting" }]);
  expect((await f.db.query("select state from jobs where sandbox_id=$1", [id])).rows).toEqual([{ state: "leased" }]);
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "failed" }]);
  const factory = await registeredJobsLane();
  const cleanup = factory({
    sql: f.sql,
    jobs: createJobsStore(f.sql, launchEncryptionKey),
    config: {},
    options: {},
    control: {},
    langfuse: { exportJob: { concurrency: 1 } },
    webhooks: {},
    outputs: { enqueueCaptures: async () => {}, drain: async () => {} },
    modal: {
      launchCleanupJob: createModalLaunchCleanupJob(f.sql, async () => {
        throw new Error("Cleanup without an allocation must not open a provider client.");
      }),
    },
  } as unknown as Parameters<LaneFactory>[0])!;
  expect(await cleanup.reconcileOne(signal)).toBe(true);
  await cleanup.drain();
  expect((await f.db.query("select state from jobs where kind='delete' and sandbox_id=$1", [id])).rows).toEqual([
    { state: "done" },
  ]);
  expect(cleanupEffects()).toEqual({ terminations: 0, cleanupPreparations: 0 });
});

test.each(["before allocation", "after allocation"] as const)(
  "an expired Modal launch settles with no App credential %s",
  async (lostCredentialAt) => {
    const { f, id, jobId, makeRunner, effects } = await modalLaunchFixture(await modalAdmissionFixture());
    const allocated = lostCredentialAt === "after allocation";
    let openCalls = 0;
    const reconcile = async (firstClaim: boolean) => {
      const runner = makeRunner((step) => {
        if (step === "open Modal") {
          openCalls++;
          if (!firstClaim || !allocated) throw new Error("Modal credential removed");
        }
        if (step === "bootstrap dispatch") throw new Error("Worker interrupted before bootstrap");
      });
      expect(await runner.reconcileOne(signal)).toBe(true);
      await runner.drain();
    };
    await reconcile(true);
    expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "leased" }]);
    await f.db.query("update jobs set deadline_at='-infinity',lease_until='-infinity' where id=$1", [jobId]);
    if (allocated)
      await f.db.query("update runtime_enrolments set enrolment_expires_at='-infinity' where sandbox_id=$1", [id]);
    await reconcile(false);
    expect(openCalls).toBe(allocated ? 2 : 1);
    expect(effects().allocations).toBe(allocated ? 1 : 0);
    expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "failed" }]);
    expect(
      (
        await f.db.query(
          "select kind,state from jobs where sandbox_id=$1 and kind in ('launch','delete') order by kind",
          [id],
        )
      ).rows,
    ).toEqual([
      { kind: "delete", state: "queued" },
      { kind: "launch", state: "failed" },
    ]);
    const cleanup = await f.store.claim("delete", crypto.randomUUID(), 30, 1);
    expect(cleanup?.payload).toEqual({ launchJobId: jobId, machineId: allocated ? "physical" : null });
  },
);

function interruptModalBinding(sql: Sql) {
  return {
    ...sql,
    transaction: (work) =>
      sql.transaction!((tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            if (query.includes("update public.sandboxes set provider_sandbox_id="))
              throw new Error("Worker lost before binding the allocation");
            return tx.query<T>(query, params);
          },
        }),
      ),
  } satisfies Sql;
}

test.each(["create response", "bootstrap dispatch", "bootstrap response"] as const)(
  "a replacement Modal launch runner completes after losing the %s",
  async (failure) => {
    const { f, id, jobId, makeRunner, effects, activeRuntime, hideAllocation } = await modalLaunchFixture(
      await modalAdmissionFixture(),
    );
    const lifecycle = createSandboxLifecycle(f.sql, async () => {
      throw new Error("Generic provider resolution cannot handle a job-owned Modal allocation.");
    });
    await f.db.query("update sandboxes set reconcile_after='-infinity' where id=$1", [id]);
    if (failure === "create response") expect(await lifecycle.reconcileOne()).toBe(false);
    const first = makeRunner((step) => {
      if (step === failure) throw new Error("Lost worker");
    });
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual(failure === "bootstrap response" ? ["physical"] : []);
    expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "leased" }]);
    await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
    if (failure === "bootstrap response") {
      await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
    }
    const pendingTicket =
      failure === "bootstrap dispatch"
        ? (
            await f.db.query<{ enrolment_hash: string }>(
              "select enrolment_hash from runtime_enrolments where sandbox_id=$1 and enrolment_expires_at>now()",
              [id],
            )
          ).rows[0]
        : undefined;
    if (failure === "bootstrap dispatch") expect(pendingTicket).toBeDefined();

    expect(await lifecycle.reconcileOne()).toBe(false);
    if (failure === "create response") {
      const interruptedBinding = makeRunner(undefined, interruptModalBinding(f.sql));
      expect(await interruptedBinding.reconcileOne(signal)).toBe(true);
      await interruptedBinding.drain();
      expect(
        (
          await f.db.query("select outcome #>> '{modal_machine,entry,machineId}' as machine_id from jobs where id=$1", [
            jobId,
          ])
        ).rows,
      ).toEqual([{ machine_id: null }]);
      expect((await f.db.query("select state,attempts from jobs where id=$1", [jobId])).rows).toEqual([
        { state: "queued", attempts: 1 },
      ]);
      await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
    }
    if (pendingTicket) {
      const interruptedReplay = makeRunner(
        (step) => {
          if (step === "bootstrap dispatch") throw new Error("Replacement lost after manifest refresh");
        },
        f.sql,
        true,
        modalTestArtifactManifest("b"),
      );
      expect(await interruptedReplay.reconcileOne(signal)).toBe(true);
      await interruptedReplay.drain();
      expect(effects().bootstrapped).toEqual([]);
      await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
    }
    const replacementManifest = modalTestArtifactManifest("c");
    const successor = makeRunner(
      async (step) => {
        if (failure === "create response" && step === "machine poll") hideAllocation();
        if (pendingTicket && step === "bootstrap dispatch") {
          expect(
            (
              await f.db.query(
                "select enrolment_hash=$2 as same_ticket from runtime_enrolments where sandbox_id=$1 and enrolment_expires_at>now()",
                [id, pendingTicket.enrolment_hash],
              )
            ).rows,
          ).toEqual([{ same_ticket: true }]);
        }
      },
      f.sql,
      true,
      replacementManifest,
    );
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    if (pendingTicket) expect(activeRuntime().configuration).toMatchObject({ artifactManifest: replacementManifest });
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual(["physical"]);
    expect(effects().observed).toBe(failure === "bootstrap response" ? 0 : 2);
    expect(
      (
        await f.db.query(
          "select s.status, j.state, j.outcome ? 'bootstrap_ticket_enc' as has_ticket from sandboxes s join jobs j on j.sandbox_id=s.id where j.id=$1",
          [jobId],
        )
      ).rows,
    ).toEqual([{ status: "ready", state: "done", has_ticket: false }]);
  },
);

test.each([
  ["stopped", "runtime ticket", undefined],
  ["unknown", "runtime ticket", undefined],
  ["unknown", "sandbox binding", undefined],
  ["stopped", "create response", undefined],
  ["plan unavailable", "create response", undefined],
  ["claim inspection unavailable", "create response", undefined],
  ["credential unavailable before observation", "create response", 1],
  ["credential unavailable after observation", "create response", 2],
  ["credential unavailable before binding", "create response", 3],
  ["credential unavailable after binding", "create response", 4],
  ["ticket unavailable", "create response", undefined],
  ["ownership unavailable", "create response", undefined],
  ["ticket and credential unavailable", "create response", 5],
  ["ownership and credential unavailable", "create response", 5],
] as const)(
  "a replacement Modal launch claimant defers bootstrap for %s after losing the %s",
  async (observation, lostAt, credentialFailure) => {
    const { f, id, jobId, makeRunner, effects, exitAllocation, hideAllocation } = await modalLaunchFixture(
      await modalAdmissionFixture(),
    );
    await f.db.query("update jobs set max_attempts=2 where id=$1", [jobId]);
    const interrupted = makeRunner(
      (step) => {
        if (step === lostAt) throw new Error("Worker lost");
      },
      lostAt === "sandbox binding" ? interruptModalBinding(f.sql) : f.sql,
    );
    expect(await interrupted.reconcileOne(signal)).toBe(true);
    await interrupted.drain();
    expect((await f.db.query("select provider_sandbox_id from sandboxes where id=$1", [id])).rows).toEqual([
      { provider_sandbox_id: lostAt === "runtime ticket" ? "physical" : null },
    ]);
    if (lostAt === "sandbox binding") {
      expect(
        (
          await f.db.query("select outcome #>> '{modal_machine,entry,machineId}' as machine_id from jobs where id=$1", [
            jobId,
          ])
        ).rows,
      ).toEqual([{ machine_id: "physical" }]);
    }
    if (observation === "stopped") exitAllocation();
    await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);

    let credentialChecks = 0;
    let inspectionFailed = false;
    const replacementSql = {
      ...f.sql,
      async query<T>(query: string, params?: unknown[]) {
        if (
          observation === "claim inspection unavailable" &&
          !inspectionFailed &&
          query.includes("else 'dispatch' end as state")
        ) {
          inspectionFailed = true;
          throw new Error("Initial job inspection unavailable");
        }
        return f.sql.query<T>(query, params);
      },
    } satisfies Sql;
    const replacement = makeRunner((step) => {
      if (step === "dispatch credential" && ++credentialChecks === credentialFailure)
        throw new Error("Modal credential recheck unavailable");
      if (observation === "unknown" && step === "machine poll") throw new Error("Modal poll unavailable");
      if (observation === "plan unavailable" && step === "open Modal")
        throw new Error("Modal credential read unavailable");
      if (
        (observation === "ticket unavailable" || observation === "ticket and credential unavailable") &&
        step === "runtime ticket"
      )
        throw new Error("Runtime ticket preparation unavailable");
      if (
        (observation === "ownership unavailable" || observation === "ownership and credential unavailable") &&
        step === "exact machine ownership"
      )
        throw new Error("Modal ownership lookup timed out");
    }, replacementSql);
    expect(await replacement.reconcileOne(signal)).toBe(true);
    await replacement.drain();
    expect(inspectionFailed).toBe(observation === "claim inspection unavailable");
    const reads =
      observation === "plan unavailable" || observation === "claim inspection unavailable" || credentialFailure === 1
        ? 0
        : 1;
    expect(effects()).toEqual({ allocations: 1, observed: reads, bootstrapped: [] });
    if (lostAt === "sandbox binding") {
      expect((await f.db.query("select provider_sandbox_id from sandboxes where id=$1", [id])).rows).toEqual([
        { provider_sandbox_id: null },
      ]);
    }
    const status = observation === "stopped" ? "failed" : "starting";
    expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status }]);
    if (observation === "stopped") {
      hideAllocation();
      expect(await replacement.reconcileOne(signal)).toBe(true);
      await replacement.drain();
      expect(
        (await f.db.query("select stopped_at is not null as confirmed from sandboxes where id=$1", [id])).rows,
      ).toEqual([{ confirmed: true }]);
    } else {
      expect((await f.db.query("select state, attempts from jobs where id=$1", [jobId])).rows).toEqual([
        { state: "queued", attempts: 1 },
      ]);
      expect(await f.store.claim("delete", crypto.randomUUID(), 30, 1)).toBeUndefined();
      await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
      const next = makeRunner();
      expect(await next.reconcileOne(signal)).toBe(true);
      await next.drain();
      expect(effects()).toEqual({ allocations: 1, observed: reads + 1, bootstrapped: ["physical"] });
      expect((await f.db.query("select state, attempts from jobs where id=$1", [jobId])).rows).toEqual([
        { state: "done", attempts: 2 },
      ]);
    }
  },
);

test.each([
  "initial enrolment read",
  "initial dispatch check",
  "manifest refresh",
  "final credential recheck",
  "deferred enrolment read",
] as const)("a transient %s leaves the last Modal bootstrap replay attempt available", async (failure) => {
  const { f, id, jobId, makeRunner, effects, activeRuntime } = await modalLaunchFixture(await modalAdmissionFixture());
  await f.db.query("update jobs set max_attempts=2 where id=$1", [jobId]);
  const interrupted = makeRunner((step) => {
    if (step === "bootstrap dispatch") throw new Error("Worker lost before calling Modal");
  });
  expect(await interrupted.reconcileOne(signal)).toBe(true);
  await interrupted.drain();
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);

  let refreshedManifest = false;
  let readInitialEnrolment = false;
  let deferredDispatch = false;
  let injected = false;
  const transientFailure = () => {
    injected = true;
    throw new Error("Replay preparation temporarily unavailable");
  };
  const faultySql = {
    ...f.sql,
    async query<T>(query: string, params?: unknown[]) {
      if (
        failure === "initial dispatch check" &&
        readInitialEnrolment &&
        !injected &&
        query.includes("else 'dispatch' end as state")
      )
        transientFailure();
      return f.sql.query<T>(query, params);
    },
    async transaction(work) {
      let updatedManifest = false;
      const result = await f.sql.transaction!((tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            if (query.includes("as cancel_without_provider")) {
              if (!readInitialEnrolment && failure === "initial enrolment read") transientFailure();
              if (deferredDispatch && failure === "deferred enrolment read") transientFailure();
              readInitialEnrolment = true;
            }
            const rows = await tx.query<T>(query, params);
            if (query.includes("update public.runtime_enrolments set configuration_enc=")) {
              updatedManifest = true;
              if (failure === "manifest refresh") transientFailure();
            }
            return rows;
          },
        }),
      );
      refreshedManifest ||= updatedManifest;
      return result;
    },
  } satisfies Sql;
  const replacement = makeRunner((step) => {
    if (step !== "dispatch credential" || !refreshedManifest) return;
    if (failure === "final credential recheck") transientFailure();
    if (failure === "deferred enrolment read") {
      deferredDispatch = true;
      throw new Error("Final credential read temporarily unavailable");
    }
  }, faultySql);
  expect(await replacement.reconcileOne(signal)).toBe(true);
  await replacement.drain();
  expect(injected).toBe(true);
  expect(effects().bootstrapped).toEqual([]);
  expect((await f.db.query("select state,attempts from jobs where id=$1", [jobId])).rows).toEqual([
    { state: "queued", attempts: 1 },
  ]);

  await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
  const manifest = modalTestArtifactManifest("b");
  const successor = makeRunner(undefined, f.sql, true, manifest);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(effects()).toMatchObject({ allocations: 1, bootstrapped: ["physical"] });
  expect(activeRuntime().configuration).toMatchObject({ artifactManifest: manifest });
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
});

test("an unreadable Modal bootstrap replay ticket still consumes the dispatch attempt", async () => {
  const { f, jobId, makeRunner, effects } = await modalLaunchFixture(await modalAdmissionFixture());
  await f.db.query("update jobs set max_attempts=2 where id=$1", [jobId]);
  const interrupted = makeRunner((step) => {
    if (step === "bootstrap dispatch") throw new Error("Worker lost before calling Modal");
  });
  expect(await interrupted.reconcileOne(signal)).toBe(true);
  await interrupted.drain();
  await f.db.query(
    `update jobs set lease_until='-infinity',
      outcome=jsonb_set(outcome,'{bootstrap_ticket_enc}',to_jsonb($2::text),false) where id=$1`,
    [jobId, Buffer.alloc(32).toString("base64")],
  );

  const replacement = makeRunner();
  expect(await replacement.reconcileOne(signal)).toBe(true);
  await replacement.drain();
  expect(effects().bootstrapped).toEqual([]);
  expect((await f.db.query("select state,attempts from jobs where id=$1", [jobId])).rows).toEqual([
    { state: "leased", attempts: 2 },
  ]);
});

test("interrupted Modal bootstrap ticket issuance rolls back the ticket and its replay material", async () => {
  const { f, id, jobId, makeRunner, effects } = await modalLaunchFixture(await modalAdmissionFixture());
  const interrupted: Sql = {
    ...f.sql,
    transaction: (work) =>
      f.sql.transaction!(async (tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            const result = await tx.query<T>(query, params);
            if (query.includes("jsonb_build_object('bootstrap_ticket_enc'"))
              throw new Error("Launch worker lost before ticket commit");
            return result;
          },
        }),
      ),
  };
  const first = makeRunner(undefined, interrupted);
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect((await f.db.query("select sandbox_id from runtime_enrolments where sandbox_id=$1", [id])).rows).toEqual([]);
  expect(
    (await f.db.query("select outcome ? 'bootstrap_ticket_enc' as has_ticket from jobs where id=$1", [jobId])).rows,
  ).toEqual([{ has_ticket: false }]);
  expect(effects().bootstrapped).toEqual([]);

  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const replacement = makeRunner();
  expect(await replacement.reconcileOne(signal)).toBe(true);
  await replacement.drain();
  expect(effects().allocations).toBe(1);
  expect(effects().bootstrapped).toEqual(["physical"]);
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
});

test("a job-launched Modal sandbox can use its reserved extension headroom", async () => {
  const { f, id, jobId, makeRunner, retentionHost, activeRuntime } = await modalLaunchFixture(
    await modalAdmissionFixture(),
  );
  const runner = makeRunner();
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();

  const store = createSqlData(f.sql)({
    via: "service",
    userId: f.people.owner,
    orgs: [{ orgId: f.people.org, role: "member" }],
  }).sandboxes;
  const sandbox = (await store.get(id))!;
  const provider = retentionHost().provider;
  const { created_at } = (await f.db.query<{ created_at: Date }>("select created_at from jobs where id=$1", [jobId]))
    .rows[0]!;
  const hardDeadline = new Date(created_at.getTime() + 3_600_000);
  const extension = await extendSandbox(store, sandbox, provider, 1860);
  expect((await provider.get(sandbox.providerSandboxId)).expiresAt).toEqual(hardDeadline);
  expect(activeRuntime().configuration).toMatchObject({ grant: { expiresAt: hardDeadline.getTime() } });
  expect((await store.get(id))!).toMatchObject({
    expiresAt: extension.expiresAt,
    lifecycleGeneration: sandbox.lifecycleGeneration,
  });
});

test("interrupted Modal enrolment rolls back readiness and the provider handoff and leaves its ticket usable", async () => {
  const { f, id, makeRunner, enrolPending } = await modalLaunchFixture();
  const runner = makeRunner(undefined, f.sql, false);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();

  const interrupted = createRuntimeEnrolments(
    {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!(async (tx) => {
          await work(tx);
          expect((await tx.query("select status from sandboxes where id=$1", [id])).rows).toEqual([
            { status: "ready" },
          ]);
          throw new Error("Enrolment worker lost before commit");
        }),
    },
    launchEncryptionKey,
  );
  await expect(enrolPending(interrupted)).rejects.toThrow("Enrolment worker lost before commit");
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "starting" }]);
  const placement = () => f.db.query("select id from modal_machines where id='physical'").then(({ rows }) => rows);
  expect(await placement()).toEqual([]);
  await expect(enrolPending()).resolves.toMatchObject({ sandboxId: id });
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
  expect(await placement()).toEqual([{ id: "physical" }]);
});

test("Modal takeover after a lost baseline capture response enrols the original machine", async () => {
  const { f, id, jobId, makeRunner, effects, retentionEffects } = await modalLaunchFixture(
    await modalAdmissionFixture(),
  );
  const first = makeRunner((step) => {
    if (step === "baseline capture response") throw new Error("Lost process baseline response");
  });
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect((await f.db.query("select 1 from runtime_enrolments where sandbox_id=$1", [id])).rows).toEqual([]);
  expect(effects().bootstrapped).toEqual([]);

  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
  expect(effects()).toMatchObject({ allocations: 1, bootstrapped: ["physical"] });
  expect(retentionEffects().baselineCaptures).toBe(2);
});

test("an expired Modal bootstrap ticket is replaced without recapturing the process baseline", async () => {
  const { f, id, jobId, makeRunner, effects, retentionEffects } = await modalLaunchFixture(
    await modalAdmissionFixture(),
  );
  const original = makeRunner(undefined, f.sql, false);
  expect(await original.reconcileOne(signal)).toBe(true);
  await original.drain();
  expect(effects().bootstrapped).toEqual(["physical"]);
  await f.db.query("update runtime_enrolments set enrolment_expires_at='-infinity' where sandbox_id=$1", [id]);
  await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
  expect(effects().allocations).toBe(1);
  expect(retentionEffects().baselineCaptures).toBe(1);
});

test("Modal bootstrap without enrolment retries, then fails and hands off cleanup when expired", async () => {
  const { f, id, jobId, makeRunner, effects } = await modalLaunchFixture();
  const runner = makeRunner(undefined, f.sql, false);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(effects().bootstrapped).toEqual(["physical"]);
  expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "queued" }]);

  await f.db.query("update jobs set run_after='-infinity' where id=$1", [jobId]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(effects().bootstrapped).toEqual(["physical"]);
  expect((await f.db.query("select state, attempts from jobs where id=$1", [jobId])).rows).toEqual([
    { state: "queued", attempts: 1 },
  ]);

  await f.db.query("update jobs set run_after='-infinity', deadline_at='-infinity' where id=$1", [jobId]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "failed" }]);
  expect((await f.db.query("select state from jobs where kind='delete' and sandbox_id=$1", [id])).rows).toEqual([
    { state: "queued" },
  ]);
  expect(effects().bootstrapped).toEqual(["physical"]);
});

test("enrolment committed before Modal failure settlement prevents cleanup", async () => {
  const { f, id, jobId, makeRunner, effects, enrolPending } = await modalLaunchFixture();
  const initial = makeRunner(undefined, f.sql, false);
  expect(await initial.reconcileOne(signal)).toBe(true);
  await initial.drain();
  await f.db.query("update jobs set run_after='-infinity', deadline_at='-infinity' where id=$1", [jobId]);

  let enrolled = false;
  let enrolmentReads = 0;
  const lateEnrolment: Sql = {
    ...f.sql,
    async transaction(work) {
      let readFailureTarget = false;
      const result = await f.sql.transaction!(async (tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            if (query.includes("as cancel_without_provider") && ++enrolmentReads === 2) readFailureTarget = true;
            return tx.query<T>(query, params);
          },
        }),
      );
      if (readFailureTarget && !enrolled) {
        await enrolPending();
        enrolled = true;
      }
      return result;
    },
  };
  const expiring = makeRunner(undefined, lateEnrolment);
  expect(await expiring.reconcileOne(signal)).toBe(true);
  await expiring.drain();
  expect(enrolled).toBe(true);
  expect((await f.db.query("select kind, state from jobs where sandbox_id=$1", [id])).rows).toEqual([
    { kind: "launch", state: "leased" },
  ]);

  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect((await f.db.query("select kind, state from jobs where sandbox_id=$1", [id])).rows).toEqual([
    { kind: "launch", state: "done" },
  ]);
  expect(effects().bootstrapped).toEqual(["physical"]);
});

test.each([
  ["deadline expires", "image lookup"],
  ["deadline expires", "runtime ticket"],
  ["Modal credential is revoked", "image lookup"],
  ["Modal credential is revoked", "runtime ticket"],
] as const)(
  "a Modal launch whose %s during %s cannot dispatch the prepared operation",
  async (change, interruptedAt) => {
    const { f, jobId, makeRunner, effects, retentionEffects, revokeModalCredential } = await modalLaunchFixture();
    const runner = makeRunner(async (step) => {
      if (step !== interruptedAt) return;
      if (change === "Modal credential is revoked") await revokeModalCredential();
      else await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(interruptedAt === "image lookup" ? 0 : 1);
    expect(retentionEffects().baselineCaptures).toBe(0);
    expect(effects().bootstrapped).toEqual([]);
  },
);

test.each(["credential rotation", "sandbox account change"] as const)(
  "Modal ticket issuance rejects %s after configuration",
  async (change) => {
    const { f, id, makeRunner, effects } = await modalLaunchFixture(await modalAdmissionFixture());
    const runner = makeRunner(async (step) => {
      if (step !== "runtime ticket") return;
      if (change === "credential rotation")
        await f.db.query("update credentials set value_enc=decode('00','hex') where id=$1", [f.openaiCredentialId]);
      else await f.db.query("update sandboxes set credential_version=credential_version+1 where id=$1", [id]);
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual([]);
    expect((await f.db.query("select sandbox_id from runtime_enrolments where sandbox_id=$1", [id])).rows).toEqual([]);
  },
);

test.each(["expiry", "revoked membership"] as const)(
  "a Modal job cannot allocate compute after sandbox %s",
  async (revokedBy) => {
    const { f, id, makeRunner, effects } = await modalLaunchFixture();
    if (revokedBy === "expiry") await f.db.query("update sandboxes set expires_at='-infinity' where id=$1", [id]);
    else await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    const runner = makeRunner();
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(0);
  },
);

async function turnFixture() {
  const f = await fixture();
  const key = btoa("\0".repeat(32));
  const queue = createAccountTurnQueue(f.sql, key);
  const caller = { userId: f.people.owner, via: "service", orgs: [{ orgId: f.people.org, role: "member" }] } as const;
  const accept = async (id: string) => {
    await f.db.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [
      id,
      f.openaiCredentialId,
    ]);
    const request = crypto.randomUUID();
    expect(
      await queue.accept({ ...caller, orgs: [...caller.orgs] }, { id, request_id: request, prompt: "queued" }),
    ).toMatchObject({ status: "queued" });
    return request;
  };
  const retryAt = new Date("2100-01-01T00:00:01Z");
  const runnerFor = (send: DispatchTurn, store = f.store, dispatchSql = f.sql) =>
    createJobsRunner(
      store,
      { turn_dispatch: createTurnDispatchJob(dispatchSql, key, send, () => retryAt.getTime() - 1_000) },
      () => {},
      () => () => {},
    );
  return {
    ...f,
    queue,
    caller: { ...caller, orgs: [...caller.orgs] },
    accept,
    retryAt,
    runnerFor,
    async makeDue(sandboxId: string) {
      await f.db.query("update jobs set run_after='-infinity' where sandbox_id=$1", [sandboxId]);
    },
  };
}

function queueLockRefusalSql(f: Awaited<ReturnType<typeof fixture>>, phase: "admission" | "completion") {
  return sqlOver({
    unsafe: async (query, params) => (await f.db.query(query, params)).rows,
    begin: (work) =>
      f.db.transaction((tx) => {
        let completing = false;
        return work({
          async unsafe(query, params) {
            if (query.startsWith("select public.complete_job(")) completing = true;
            if (query.startsWith("lock table public.account_turn_queue") && (phase === "admission" || completing))
              throw Object.assign(new Error("Model repair holds the queue lock"), { code: "55P03" });
            return (await tx.query(query, params)).rows;
          },
        });
      }),
  });
}

test("shared turn admission defers without spending an attempt during model repair", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  await f.accept(id);
  const sent: string[] = [];
  const send: DispatchTurn = async (_caller, input) => sent.push(input.id);
  const runner = f.runnerFor(send, f.store, queueLockRefusalSql(f, "admission"));
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect(
    (
      await f.db.query(
        `select q.state as receipt, j.state as job, j.attempts,
                exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
         from account_turn_queue q join jobs j using (sandbox_id) where q.sandbox_id=$1`,
        [id],
      )
    ).rows,
  ).toEqual([{ receipt: "queued", job: "queued", attempts: 0, reserved: false }]);

  await f.makeDue(id);
  const successor = f.runnerFor(send);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(sent).toEqual([id]);
});

test("an exhausted dispatch job leaves a live receipt available to its sender", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  await f.db.query("update jobs set attempts=max_attempts where sandbox_id=$1", [id]);
  const store = {
    ...f.store,
    async complete(...args: Parameters<typeof f.store.complete>) {
      await f.db.query(
        `update account_turn_queue set state='dispatching', dispatch_generation=queued_generation,
         dispatch_until=clock_timestamp()+interval '15 minutes' where sandbox_id=$1 and state='queued'`,
        [id],
      );
      return f.store.complete(...args);
    },
  };
  const runner = f.runnerFor(async () => {
    throw new Error("The shared runner must not dispatch an exhausted job.");
  }, store);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(
    (
      await f.db.query(
        `select j.state as job, q.state as receipt, j.attempts=j.max_attempts as exhausted,
              j.run_after=q.dispatch_until as deferred
       from jobs j join account_turn_queue q using(sandbox_id) where q.request_id=$1`,
        [request],
      )
    ).rows,
  ).toEqual([{ job: "queued", receipt: "dispatching", exhausted: true, deferred: true }]);
});

test.each(["deadline", "attempts"] as const)(
  "the turn handler settles receipts after exhausting %s",
  async (budget) => {
    const f = await turnFixture();
    const id = await sandbox(f, true);
    const request = await f.accept(id);
    const uncertain = budget === "attempts";
    if (uncertain) {
      await f.db.query(
        "update account_turn_queue set state='dispatching', dispatch_generation=2, dispatch_until='infinity' where sandbox_id=$1",
        [id],
      );
      await f.db.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
        id,
        f.openaiCredentialId,
      ]);
      await f.db.query("update jobs set attempts=max_attempts where sandbox_id=$1", [id]);
    } else {
      await f.db.query("update jobs set deadline_at='-infinity' where sandbox_id=$1", [id]);
    }
    const sent: string[] = [];
    const send: DispatchTurn = async (_caller, input) => sent.push(input.id);
    const runner = f.runnerFor(send);
    if (uncertain) {
      const repair = createJobsStore(queueLockRefusalSql(f, "completion"), btoa("\0".repeat(32)));
      const contended = f.runnerFor(send, repair);
      expect(await contended.reconcileOne(signal)).toBe(true);
      await contended.drain();
      expect(
        (
          await f.db.query(
            "select j.state as job, q.state as receipt from jobs j join account_turn_queue q using (sandbox_id) where j.sandbox_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ job: "leased", receipt: "dispatching" }]);
      await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [id]);
    }
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(sent).toEqual([]);
    expect(
      (
        await f.db.query(
          `select j.state as job, q.state as receipt, q.failure_reason,
           exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
         from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id
         where j.sandbox_id=$1 and q.request_id=$2`,
          [id, request],
        )
      ).rows,
    ).toEqual([
      {
        job: "failed",
        receipt: "failed",
        failure_reason: uncertain
          ? "Dispatch outcome uncertain; inspect sandbox history before resending."
          : "Queued prompt could not start before its dispatch budget expired.",
        reserved: uncertain,
      },
    ]);
  },
);

test("the turn handler waits for FIFO and capacity without spending its dispatch budget", async () => {
  const f = await turnFixture();
  const occupied = await sandbox(f);
  const first = await sandbox(f);
  const later = await sandbox(f);
  await f.db.query("update credentials set max_agents=1 where id=$1", [f.openaiCredentialId]);
  const firstRequest = await f.accept(first);
  const laterRequest = await f.accept(later);
  await expect(f.queue.accept(f.caller, { id: first, request_id: firstRequest, prompt: "changed" })).rejects.toThrow(
    "identical input",
  );
  await f.makeDue(later);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    const promptId = `actual_${input.request_id}`;
    await f.db.query("update sandboxes set status='running',task_prompt_id=$2 where id=$1", [input.id, promptId]);
    return { promptId, status: "running" };
  });
  const tick = async () => {
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
  };
  await tick();
  expect(sent).toEqual([]);
  await f.db.query("update sandboxes set status='running',task_prompt_id='active_turn',credential_id=$2 where id=$1", [
    occupied,
    f.openaiCredentialId,
  ]);
  for (let wait = 0; wait < 4; wait++) {
    await f.makeDue(first);
    await tick();
  }
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, state, run_after from jobs")).rows).toEqual([
    { attempts: 0, state: "queued", run_after: f.retryAt },
    { attempts: 0, state: "queued", run_after: f.retryAt },
  ]);
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [
    occupied,
  ]);
  await f.makeDue(first);
  await tick();
  await f.makeDue(later);
  await tick();
  expect(sent).toEqual([first]);
  expect(await f.queue.status(f.caller, first)).toEqual({
    nativePromptId: `actual_${firstRequest}`,
    publicPromptId: firstRequest,
  });
  expect(await f.queue.status(f.caller, first, firstRequest)).toEqual({ nativePromptId: `actual_${firstRequest}` });
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,$2,true)", [
    first,
    `actual_${firstRequest}`,
  ]);
  await f.makeDue(later);
  await tick();
  expect(sent).toEqual([first, later]);
  expect(await f.queue.status(f.caller, later, laterRequest)).toEqual({ nativePromptId: `actual_${laterRequest}` });
});

test.each(["unsettled prompt", "revoked actor"] as const)("the turn handler respects %s", async (condition) => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  if (condition === "unsettled prompt")
    await f.db.query("update sandboxes set task_prompt_id='active_turn' where id=$1", [id]);
  else
    await f.db.query("update mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
      f.people.org,
      f.people.owner,
    ]);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
  if (condition === "revoked actor") {
    expect(await f.queue.status(f.caller, id, request)).toMatchObject({ failed: true });
  } else {
    await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [
      id,
    ]);
    await f.makeDue(id);
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(sent).toEqual([id]);
    expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
  }
});

test("interrupted turn deferral leaves the claim available to a successor after expiry", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  await f.db.query("update sandboxes set task_prompt_id='active_turn' where id=$1", [id]);
  const interrupted = createJobsStore(
    {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!(async (tx: Sql) => {
          await work(tx);
          throw new Error("Connection lost before deferral commit.");
        }),
    },
    btoa("\0".repeat(32)),
  );
  const sent: string[] = [];
  const send: DispatchTurn = async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  };
  const first = f.runnerFor(send, { ...f.store, complete: interrupted.complete });
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect((await f.db.query("select state, attempts from jobs")).rows).toEqual([{ state: "leased", attempts: 1 }]);
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [id]);
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [id]);
  const successor = f.runnerFor(send);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test("the turn handler defers an open dispatch window and recovers after it expires", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  await f.db.query(
    `update account_turn_queue set state='dispatching',dispatch_generation=queued_generation,
       dispatch_until='infinity' where sandbox_id=$1`,
    [id],
  );
  await f.db.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
    id,
    f.openaiCredentialId,
  ]);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, state from jobs")).rows).toEqual([{ attempts: 0, state: "queued" }]);
  await f.db.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [id]);
  await f.makeDue(id);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test("a generation change before turn admission retargets the job without charging an attempt", async () => {
  const f = await turnFixture();
  const id = await sandbox(f);
  const request = await f.accept(id);
  let advanced = false;
  const sent: string[] = [];
  const runner = f.runnerFor(
    async (_caller, input) => {
      sent.push(input.id);
      return { promptId: input.request_id, status: "running" };
    },
    {
      ...f.store,
      async inspect(job, owner, tx) {
        const state = await f.store.inspect(job, owner, tx);
        if (state === "dispatch" && !advanced) {
          advanced = true;
          await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [id]);
        }
        return state;
      },
    },
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, generation::text, state from jobs")).rows).toEqual([
    { attempts: 0, generation: "3", state: "queued" },
  ]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test.each([
  "queued",
  "native evidence",
  "runtime evidence",
  "current native evidence",
  "current runtime evidence",
  "other request evidence",
  "dispatching",
  "stopped with queued",
  "stopped with queued dispatch evidence",
  "stopped with dispatching",
  "stopped after retarget",
  "wake-on-send",
  "failed",
  "admitted",
  "missing",
] as const)("a turn job reconciles a %s receipt at claim", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f, scenario === "dispatching");
  const requestId = crypto.randomUUID();
  if (scenario !== "missing") await seedTurn(f, sandboxId, requestId);
  const options = { orgId: people.org, maxAttempts: 2 };
  const enqueue = () => store.enqueue("turn_dispatch", sandboxId, 2, requestId, { requestId }, options);
  const id = await enqueue();
  const retargetedBeforeStop = scenario === "stopped after retarget";
  const cancelled =
    scenario === "stopped with queued" ||
    scenario === "stopped with queued dispatch evidence" ||
    scenario === "stopped with dispatching" ||
    retargetedBeforeStop;
  const stopped = cancelled || scenario === "wake-on-send";
  const nativeEvidence = scenario === "native evidence" || scenario === "current native evidence";
  const runtimeEvidence = scenario === "runtime evidence" || scenario === "current runtime evidence";
  const otherEvidence = scenario === "other request evidence";
  const currentGeneration = scenario === "wake-on-send" || scenario.startsWith("current") || otherEvidence;
  const exactEvidence = nativeEvidence || runtimeEvidence;
  const state =
    scenario === "stopped with dispatching" || scenario === "dispatching"
      ? "dispatching"
      : scenario === "failed" || scenario === "admitted"
        ? scenario
        : "queued";
  if (retargetedBeforeStop) await db.query("update jobs set generation=3 where id=$1", [id]);
  await db.query("update account_turn_queue set state=$1, native_prompt_id=$2 where sandbox_id=$3", [
    state,
    nativeEvidence ? "prior-prompt" : null,
    sandboxId,
  ]);
  if (scenario !== "failed")
    await db.query(
      `update sandboxes set lifecycle_generation=$6, status=$2, stopped_at=$3,
           activity_lease_id=$4, activity_until=$5 where id=$1`,
      [
        sandboxId,
        stopped ? "stopped" : "ready",
        stopped ? "2026-01-01" : null,
        runtimeEvidence ? requestId : otherEvidence ? crypto.randomUUID() : null,
        runtimeEvidence || otherEvidence ? "infinity" : null,
        currentGeneration ? 2 : 3,
      ],
    );
  if (scenario === "stopped with queued dispatch evidence")
    await db.query("update sandboxes set task_prompt_id=$2 where id=$1", [sandboxId, requestId]);
  const delivered: Job[] = [];
  const runner = createJobsRunner(
    store,
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job) {
          delivered.push(job);
          return { status: "done" };
        },
      },
    },
    () => {},
    () => () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  const retargeted = scenario === "queued";
  expect(delivered).toHaveLength(retargeted || scenario === "wake-on-send" || otherEvidence ? 1 : 0);
  if (retargeted) expect(delivered[0]).toMatchObject({ id, generation: "3", payload: { requestId } });
  expect((await db.query("select state, generation::text from jobs where id=$1", [id])).rows).toEqual([
    {
      state:
        retargeted ||
        scenario === "wake-on-send" ||
        otherEvidence ||
        scenario === "failed" ||
        scenario === "admitted" ||
        scenario === "missing"
          ? "done"
          : "failed",
      generation: retargeted || retargetedBeforeStop ? "3" : "2",
    },
  ]);
  if (cancelled || exactEvidence)
    expect(
      (await db.query("select state, failure_reason from account_turn_queue where request_id=$1", [requestId])).rows,
    ).toEqual([
      {
        state: "failed",
        failure_reason:
          scenario === "stopped with queued dispatch evidence" || exactEvidence
            ? "Queued receipt already has dispatch evidence; inspect sandbox history before resending."
            : state === "queued"
              ? "Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping."
              : "Dispatch cancelled by confirmed stop.",
      },
    ]);
  expect(await enqueue()).toBe(id);
});

test.each([
  ["native generation changed", 3, null, "-infinity", false, true],
  ["native request started at the job generation", 2, "request", "-infinity", false, true],
  ["native request started without a legacy window", 2, "request", null, false, true],
  ["native legacy window still open", 2, "request", "infinity", false, false],
  ["runtime request started", 2, "request", "-infinity", true, false],
  ["runtime request advanced generation", 3, "request", "-infinity", true, false],
  ["runtime request already at dispatch generation", 3, "request", "-infinity", true, false],
  ["runtime request advanced after claim", 3, "request", "-infinity", true, false],
  ["runtime retarget interrupted before commit", 3, "request", "-infinity", true, false],
  ["runtime request advanced beyond dispatch generation", 4, "request", "-infinity", true, false],
  ["runtime request advanced with an open window", 3, "request", "infinity", true, false],
  ["different runtime request advanced generation", 3, "other", "-infinity", true, false],
  ["runtime command persisted", 2, "command", "-infinity", true, false],
  ["published runtime follow-up", 3, "command", "-infinity", true, false],
  ["unfinished runtime follow-up", 3, "command", "-infinity", true, false],
  ["older-epoch runtime follow-up", 3, "command", "-infinity", true, false],
  ["published runtime resume", 3, "resume", "infinity", true, false],
  ["older-epoch runtime resume", 3, "resume", "infinity", true, false],
  ["unrelated runtime resume", 3, "resume", "-infinity", true, false],
  ["runtime legacy window still open", 2, null, "infinity", true, false],
  ["runtime dispatch has no evidence", 2, null, "-infinity", true, false],
  ["runtime dispatch has neither a window nor evidence", 2, null, null, true, false],
  ["runtime dispatch has a persisted command but no window", 2, "command", null, true, false],
  ["stopped runtime dispatch has no evidence", 2, null, "-infinity", true, false],
  ["older job for abandoned runtime dispatch", 3, null, "-infinity", true, false],
  ["native receipt has a prompt ID", 2, "prompt", "-infinity", false, true],
  ["native dispatch has no evidence", 2, null, "-infinity", false, false],
  ["older job for abandoned native dispatch", 3, null, "-infinity", false, false],
  ["native dispatch has neither a window nor evidence", 2, null, null, false, false],
  ["native reset interrupted before commit", 2, null, null, false, false],
] as const)("shared claim reconciles %s", async (scenario, generation, activity, until, runtime, uncertain) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f, runtime, scenario === "stopped runtime dispatch has no evidence");
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 2,
    },
  );
  await db.query(
    `update account_turn_queue set state='dispatching', dispatch_generation=$4, dispatch_until=$2,
       native_prompt_id=$3 where request_id=$1`,
    [
      requestId,
      until,
      activity === "prompt" ? "prior-prompt" : null,
      scenario.startsWith("older job") || scenario === "runtime request already at dispatch generation" ? 3 : 2,
    ],
  );
  await db.query(`update sandboxes set lifecycle_generation=$2, activity_lease_id=$3, activity_until=$4 where id=$1`, [
    sandboxId,
    scenario === "runtime request advanced after claim" ? 2 : generation,
    activity === "request" ? requestId : activity === "other" ? crypto.randomUUID() : null,
    activity === "request" || activity === "other" ? "infinity" : null,
  ]);
  await db.query("insert into account_agent_reservations (sandbox_id, account_id) values ($1, $2)", [
    sandboxId,
    f.openaiCredentialId,
  ]);
  if (activity === "command") {
    const finished = scenario === "published runtime follow-up" || scenario === "older-epoch runtime follow-up";
    if (generation === 3)
      await db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
         values ($1,$2,$3,repeat('a',64))`,
        [sandboxId, generation, scenario === "older-epoch runtime follow-up" ? 2 : 1],
      );
    await db.query(
      `insert into runtime_commands (sandbox_id, request_id, epoch, request_enc, result_enc)
       values ($1,$2,1,''::bytea,case when $3 then ''::bytea end)`,
      [sandboxId, `follow_${requestId}`, finished],
    );
  }
  if (activity === "resume") {
    await db.query(
      `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
       values ($1,$2,$3,repeat('a',64))`,
      [sandboxId, generation, scenario === "older-epoch runtime resume" ? 3 : 2],
    );
    await db.query(
      `insert into runtime_resumes (sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,
         conversation_id,model,reasoning_effort,phase,verified_at,receipt)
       values ($1,$2,1,2,0,repeat('a',64),'fixture','fixture','low',
         'complete',now(),'{"resumed":true}'::jsonb)`,
      [sandboxId, scenario === "unrelated runtime resume" ? crypto.randomUUID() : requestId],
    );
  }
  const outcome = async () =>
    (
      await db.query(
        `select j.state as job_state, q.state as receipt_state, q.failure_reason,
              (q.dispatch_generation is not null or q.dispatch_until is not null) as dispatch_recorded,
              exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
       from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where j.id=$1`,
        [id],
      )
    ).rows;
  const interrupted = scenario.endsWith("interrupted before commit");
  if (interrupted) {
    const faultySql = sqlOver({
      unsafe: async (query, params) => (await db.query(query, params)).rows,
      begin: (work) =>
        db.transaction(async (tx) => {
          await work({ unsafe: async (query, params) => (await tx.query(query, params)).rows });
          throw new Error("Interrupted before reconciliation commit.");
        }),
    });
    await expect(
      createJobsStore(faultySql, btoa("\0".repeat(32))).claim("turn_dispatch", crypto.randomUUID(), 30, 1),
    ).rejects.toThrow("Interrupted before reconciliation commit.");
    expect(await outcome()).toEqual([
      {
        job_state: "leased",
        receipt_state: "dispatching",
        failure_reason: null,
        dispatch_recorded: true,
        reserved: true,
      },
    ]);
    expect((await db.query("select generation::text from jobs where id=$1", [id])).rows).toEqual([{ generation: "2" }]);
    await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
  }
  const owner = crypto.randomUUID();
  let claim = await store.claim("turn_dispatch", owner, 30, 1);
  if (scenario === "runtime request advanced after claim") {
    await db.query("update sandboxes set lifecycle_generation=$2 where id=$1", [sandboxId, generation]);
    expect(await store.inspect(claim!, owner)).toBe("stale");
    await store.retireStale(claim!, owner, "no_dispatch");
    claim = await store.claim("turn_dispatch", owner, 30, 1);
    expect(claim?.attempts).toBe(1);
  }
  const reset =
    (interrupted && !runtime) ||
    scenario.endsWith("dispatch has no evidence") ||
    scenario.endsWith("has neither a window nor evidence") ||
    scenario.startsWith("older job");
  expect(await outcome()).toEqual([
    {
      job_state: uncertain ? "failed" : "leased",
      receipt_state: uncertain ? "failed" : reset ? "queued" : "dispatching",
      failure_reason: uncertain ? "Dispatch outcome uncertain; inspect sandbox history before resending." : null,
      dispatch_recorded: !reset,
      reserved: !reset,
    },
  ]);
  if (
    reset ||
    scenario === "published runtime follow-up" ||
    scenario === "published runtime resume" ||
    scenario === "older-epoch runtime resume" ||
    scenario === "runtime request advanced generation" ||
    scenario === "runtime request already at dispatch generation" ||
    scenario === "runtime request advanced after claim" ||
    (interrupted && runtime)
  ) {
    expect(claim).toMatchObject({ id, generation: String(generation), payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe("dispatch");
  } else if (runtime && generation > 2) {
    expect(await store.inspect(claim!, owner)).toBe("stale");
  }
});

async function interruptedDockerTurn(
  status: "starting" | "running" | "stopped",
  existingFixture?: Awaited<ReturnType<typeof fixture>>,
) {
  const f = existingFixture ?? (await fixture());
  const { db, people, store } = f;
  const sandboxId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const dockerGeneration = crypto.randomUUID();
  await db.query(
    `insert into docker_hosts (id,org_id,owner_id,installation_id,hash,registration_expires_at)
       values ($1,$2,$3,$4,repeat('a',64),'-infinity')`,
    [hostId, people.org, people.owner, installationId],
  );
  await db.query(
    `insert into sandboxes (id,org_id,owner_id,harness,status,provider,lifecycle_generation,expires_at,
         visibility,access_owner_id,docker_host_id,docker_installation_id,docker_generation,docker_image,provider_sandbox_id,stopped_at)
       values ($1,$2,$3,'codex',$8::public.sandbox_status,'docker',$9,'infinity',
         'private',$3,$4,$5,$6,'sha256:' || repeat('b',64),$7,case when $8::public.sandbox_status='stopped' then now() end)`,
    [
      sandboxId,
      people.org,
      people.owner,
      hostId,
      installationId,
      dockerGeneration,
      `armada-${installationId}-${hostId}-${sandboxId}-${dockerGeneration}`,
      status,
      status === "stopped" ? 2 : 3,
    ],
  );
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    { orgId: people.org, maxAttempts: 2 },
  );
  await db.query(
    `update account_turn_queue set state='dispatching',dispatch_generation=2,dispatch_until='-infinity'
       where sandbox_id=$1 and request_id=$2`,
    [sandboxId, requestId],
  );
  await db.query("insert into account_agent_reservations (sandbox_id,account_id) values ($1,$2)", [
    sandboxId,
    f.openaiCredentialId,
  ]);
  return { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id };
}

test.each(["current", "pending", "other request", "other epoch", "old issuer", "revoked host"] as const)(
  "a Docker prompt command can retarget a stale turn only with current replay evidence (%s)",
  async (evidence) => {
    const { f, sandboxId, requestId, hostId, id } = await interruptedDockerTurn("running");
    const { db, people, store } = f;
    await db.query(
      `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash,docker_issuer_fence)
       select $1,3,2,repeat('c',64),user_id::text || ':' || (epoch + $4::bigint)::text
       from mcp_actor_epochs where org_id=$2 and user_id=$3`,
      [sandboxId, people.org, people.owner, evidence === "old issuer" ? -1 : 0],
    );
    await db.query(
      `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
       values ($1,$2,$3,''::bytea,case when $4 then ''::bytea end)`,
      [
        sandboxId,
        `docker_prompt_${evidence === "other request" ? crypto.randomUUID() : requestId}`,
        evidence === "other epoch" ? 1 : 2,
        evidence !== "pending",
      ],
    );

    if (evidence === "revoked host") await db.query("update docker_hosts set revoked_at=now() where id=$1", [hostId]);

    const owner = crypto.randomUUID();
    const claim = await store.claim("turn_dispatch", owner, 30, 1);
    const recoverable = evidence === "current" || evidence === "pending";
    expect(claim).toMatchObject({ id, generation: recoverable ? "3" : "2", payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe(recoverable ? "dispatch" : "stale");
    expect(
      (
        await db.query(
          `select q.state, exists(
             select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id and r.account_id=q.account_id
           ) as reserved from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: "dispatching", reserved: true }]);
  },
);

test.each([
  ["unsupported queued state", "queued", "starting", 2, "infinity", false, false],
  ["stop intent", "queued", "ready", 2, "infinity", true, false],
  ["expiry", "queued", "running", 2, "-infinity", false, false],
  ["failed sandbox", "dispatching", "failed", 2, "infinity", false, false],
  ["deleted sandbox", "dispatching", "deleted", 2, "infinity", false, false],
  ["stopping after claim", "dispatching", "stopping", 3, "infinity", false, true],
] as const)(
  "a turn lease settles the receipt after %s",
  async (_scenario, state, status, generation, expiry, stopRequested, afterClaim) => {
    const f = await fixture();
    const { db, people, store } = f;
    const sandboxId = await sandbox(f);
    const requestId = crypto.randomUUID();
    await seedTurn(f, sandboxId, requestId);
    await db.query(
      `update account_turn_queue set state=$2,
         dispatch_generation=case when $2='dispatching' then 2 end,
         dispatch_until=case when $2='dispatching' then 'infinity'::timestamptz end
       where request_id=$1`,
      [requestId, state],
    );
    const jobId = await store.enqueue(
      "turn_dispatch",
      sandboxId,
      2,
      requestId,
      { requestId },
      {
        orgId: people.org,
        maxAttempts: 2,
      },
    );
    const changeSandbox = () =>
      db.query(
        `update sandboxes set status=$2, lifecycle_generation=$3, expires_at=$4,
           stop_requested_at=case when $5 then now() end,
           deleted_at=case when $6 then now() end where id=$1`,
        [sandboxId, status, generation, expiry, stopRequested, status === "deleted"],
      );
    if (!afterClaim) await changeSandbox();
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    if (afterClaim) {
      await changeSandbox();
      expect(await store.inspect(job, owner)).toBe("stale");
      await store.retireStale(job, owner, "no_dispatch");
    }
    expect(await store.inspect(job, owner)).toBe("lost");
    expect((await db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "failed" }]);
    expect(
      (await db.query("select state, failure_reason from account_turn_queue where request_id=$1", [requestId])).rows,
    ).toEqual([
      {
        state: "failed",
        failure_reason:
          state === "queued"
            ? "Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping."
            : "Dispatch cancelled by confirmed stop.",
      },
    ]);
  },
);

test.each([
  "confirmed stop",
  "superseded dispatch",
  "missing dispatch generation",
  "expired adjacent dispatch without evidence",
  "expired adjacent dispatch with unrelated activity",
  "expired adjacent dispatch with an obsolete runtime command",
  "adjacent dispatch without a deadline or evidence",
  "adjacent dispatch without a deadline and with an obsolete runtime command",
  "expired adjacent dispatch with an obsolete Docker prompt",
  "adjacent dispatch without a deadline and with an obsolete Docker prompt",
] as const)("a failed receipt write rolls back retirement after %s", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const uncertain = scenario !== "confirmed stop";
  const docker = scenario.endsWith("with an obsolete Docker prompt");
  const turn = docker ? await interruptedDockerTurn("running", f) : null;
  const sandboxId = turn?.sandboxId ?? (await sandbox(f, uncertain));
  const requestId = turn?.requestId ?? crypto.randomUUID();
  if (!turn) await seedTurn(f, sandboxId, requestId);
  const id =
    turn?.id ??
    (await store.enqueue(
      "turn_dispatch",
      sandboxId,
      2,
      requestId,
      { requestId },
      {
        orgId: people.org,
        maxAttempts: 2,
      },
    ));
  if (uncertain) {
    const missingDeadline = scenario.startsWith("adjacent dispatch without a deadline");
    const adjacent = missingDeadline || scenario.startsWith("expired adjacent");
    const activityId = scenario === "expired adjacent dispatch with unrelated activity" ? crypto.randomUUID() : null;
    await db.query(
      "update sandboxes set lifecycle_generation=$2, activity_lease_id=$3, activity_until=$4 where id=$1",
      [sandboxId, adjacent ? 3 : 4, activityId, activityId ? "infinity" : null],
    );
    await db.query(
      "update account_turn_queue set state='dispatching', dispatch_generation=$2, dispatch_until=$3 where request_id=$1",
      [
        requestId,
        scenario === "missing dispatch generation" ? null : 2,
        missingDeadline ? null : adjacent ? "-infinity" : "infinity",
      ],
    );
    if (docker || scenario.endsWith("with an obsolete runtime command")) {
      await db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
         values ($1,3,2,repeat('a',64))`,
        [sandboxId],
      );
      await db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
         values ($1,$2,1,''::bytea,''::bytea)`,
        [sandboxId, `${docker ? "docker_prompt" : "follow"}_${requestId}`],
      );
    }
    if (!turn)
      await db.query("insert into account_agent_reservations (sandbox_id, account_id) values ($1, $2)", [
        sandboxId,
        f.openaiCredentialId,
      ]);
  } else {
    await db.query("update sandboxes set lifecycle_generation=3, status='stopped', stopped_at=now() where id=$1", [
      sandboxId,
    ]);
  }
  const claimAndRetire = async () => {
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    if ((await store.inspect(job, owner)) === "stale") await store.retireStale(job, owner, "no_dispatch");
  };
  await db.exec("alter table account_turn_queue add constraint reject_failure check (state <> 'failed')");
  try {
    await expect(claimAndRetire()).rejects.toThrow("reject_failure");
  } finally {
    await db.exec("alter table account_turn_queue drop constraint reject_failure");
  }
  const states = async () =>
    (
      await db.query(
        "select j.state as job, q.state as receipt from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where j.id=$1",
        [id],
      )
    ).rows;
  expect(await states()).toEqual([{ job: "leased", receipt: uncertain ? "dispatching" : "queued" }]);
  await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
  await claimAndRetire();
  expect(await states()).toEqual([{ job: "failed", receipt: "failed" }]);
  if (uncertain) {
    expect(
      (
        await db.query(
          `select q.failure_reason, q.dispatch_until, exists(
         select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id
       ) as reserved from account_turn_queue q where q.request_id=$1`,
          [requestId],
        )
      ).rows,
    ).toEqual([
      {
        failure_reason: "Dispatch outcome uncertain; inspect sandbox history before resending.",
        dispatch_until: null,
        reserved: true,
      },
    ]);
  }
});

test.each(["boat", "docker", "docker with a current prompt", "docker with an obsolete prompt"] as const)(
  "a stale %s turn preserves its open dispatch window across an interrupted requeue",
  async (provider) => {
    const f = await turnFixture();
    const setup = async () => {
      const sandboxId = await sandbox(f, true);
      const requestId = await f.accept(sandboxId);
      await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [sandboxId]);
      return { sandboxId, requestId };
    };
    const { sandboxId, requestId } = provider === "boat" ? await setup() : await interruptedDockerTurn("running", f);
    const currentPrompt = provider === "docker with a current prompt";
    const obsoletePrompt = provider === "docker with an obsolete prompt";
    if (currentPrompt || obsoletePrompt) {
      await f.db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash,docker_issuer_fence)
         select $1,3,2,repeat('c',64),user_id::text || ':' || epoch::text
         from mcp_actor_epochs where org_id=$2 and user_id=$3`,
        [sandboxId, f.people.org, f.people.owner],
      );
      await f.db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
         values ($1,$2,$3,''::bytea,case when $4::boolean then ''::bytea end)`,
        [sandboxId, `docker_prompt_${requestId}`, obsoletePrompt ? 1 : 2, obsoletePrompt],
      );
    }
    await f.makeDue(sandboxId);
    await f.db.query(
      `update account_turn_queue set state='dispatching', dispatch_generation=2, dispatch_until='2100-01-01T00:00:00Z'
     where request_id=$1`,
      [requestId],
    );
    let dispatches = 0;
    const send: DispatchTurn = async () => {
      dispatches++;
      throw new Error("Stale receipt must not dispatch");
    };
    const interrupted = createJobsStore(
      {
        ...f.sql,
        transaction: (work) =>
          f.sql.transaction!(async (tx) => {
            await work(tx);
            throw new Error("Connection lost before stale turn requeue commit.");
          }),
      },
      btoa("\0".repeat(32)),
    );
    const state = () =>
      f.db.query(
        `select j.state as job, q.state as receipt, j.attempts, j.generation::text,
              (j.run_after=q.dispatch_until) as waits_for_receipt
       from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where q.request_id=$1`,
        [requestId],
      );
    const first = f.runnerFor(send, { ...f.store, retireStale: interrupted.retireStale });
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect((await state()).rows).toEqual([
      { job: "leased", receipt: "dispatching", attempts: 1, generation: "2", waits_for_receipt: false },
    ]);
    await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [sandboxId]);

    const runner = f.runnerFor(send);
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect((await state()).rows).toEqual([
      { job: "queued", receipt: "dispatching", attempts: 1, generation: "2", waits_for_receipt: true },
    ]);
    expect(await runner.reconcileOne(signal)).toBe(false);
    expect(dispatches).toBe(0);
    if (obsoletePrompt) return;
    await f.db.query("update account_turn_queue set dispatch_until='-infinity' where request_id=$1", [requestId]);
    await f.makeDue(sandboxId);
    if (currentPrompt) {
      const owner = crypto.randomUUID();
      const claim = await f.store.claim("turn_dispatch", owner, 30, 1);
      expect(claim).toMatchObject({ generation: "3", payload: { requestId } });
      expect(await f.store.inspect(claim!, owner)).toBe("dispatch");
      expect(dispatches).toBe(0);
      return;
    }
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect((await state()).rows).toEqual([
      { job: "failed", receipt: "failed", attempts: 2, generation: "2", waits_for_receipt: null },
    ]);
    expect(dispatches).toBe(0);
  },
);

test("transactional enqueue wakes after commit and replays the encrypted job by key", async () => {
  const { sql, people, store } = await fixture();
  const payload = { operation: "sample" };
  const enqueue = (tx = sql) =>
    store.enqueue("sample", null, null, "event", payload, { orgId: people.org, maxAttempts: 1 }, tx);
  let wakes = 0;
  const close = runtimeWakes.subscribe(JOBS_WAKE, () => wakes++);
  try {
    const id = await sql.transaction!(async (tx) => {
      const inserted = await enqueue(scopedRuntimeSql(tx));
      expect(wakes).toBe(0);
      return inserted;
    });
    expect(await enqueue()).toBe(id);
    expect(wakes).toBe(1);
    let delivered: unknown;
    const runner = createJobsRunner(store, {
      sample: {
        concurrency: 1,
        async run(job) {
          delivered = job.payload;
          return { status: "done" };
        },
      },
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(delivered).toEqual(payload);
    expect((await sql.query("select state from public.jobs where id = $1", [id])).rows).toEqual([{ state: "done" }]);
  } finally {
    close();
  }
});

test("a second generation advance before inspection requeues the same pending send", async () => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 1,
    },
  );
  await db.query("update sandboxes set lifecycle_generation=3 where id=$1", [sandboxId]);
  const dispatched: Job[] = [];
  const runner = createJobsRunner(
    {
      ...store,
      async inspect(job, owner) {
        if (job.generation === "3")
          await db.query("update sandboxes set lifecycle_generation=4 where id=$1", [sandboxId]);
        return store.inspect(job, owner);
      },
    },
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job, context) {
          if (await context.canDispatch()) dispatched.push(job);
          return { status: "done" };
        },
      },
    },
    () => {},
    () => () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(dispatched).toEqual([]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toMatchObject({ id, generation: "4", attempts: 1, payload: { requestId } });
});

test("receipt lock contention releases the claim without spending a dispatch attempt", async () => {
  const f = await fixture();
  const { db, people, sql, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 1,
    },
  );
  const contended = createJobsStore(
    {
      ...sql,
      transaction: async () => {
        throw Object.assign(new Error("Receipt lock unavailable"), { code: "55P03" });
      },
    },
    btoa("\0".repeat(32)),
  );
  const owner = crypto.randomUUID();
  const job = (await contended.claim("turn_dispatch", owner, 30, 1))!;
  expect(await store.inspect(job, owner)).toBe("lost");
  expect(
    (await db.query("select state, attempts, run_after > created_at as delayed from jobs where id=$1", [id])).rows,
  ).toEqual([{ state: "queued", attempts: 0, delayed: true }]);
  await db.query("update jobs set run_after='-infinity' where id=$1", [id]);
  const successorOwner = crypto.randomUUID();
  const successor = (await store.claim("turn_dispatch", successorOwner, 30, 1))!;
  expect(await store.inspect(successor, successorOwner)).toBe("dispatch");
});

test.each([1, 2])("a stale lifecycle lease is retired from claim generation %i", async (generation) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const options = { orgId: people.org, maxAttempts: 2, deadline: new Date("2100-01-01") };
  const id = await store.enqueue("stop", sandboxId, generation, "old", null, options);
  let invoked = false;
  const runner = createJobsRunner(store, {
    stop: {
      concurrency: 1,
      async run() {
        invoked = true;
        await db.query("delete from sandboxes where id = $1", [sandboxId]);
        return { status: "done" };
      },
    },
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(invoked).toBe(generation === 2);
  expect((await db.query("select state, outcome from jobs where id = $1", [id])).rows).toEqual([
    { state: "failed", outcome: { reason: "stale_generation" } },
  ]);
});

test.each([
  "complete",
  "takeover",
  "stale",
  "interrupted",
  "not advanced",
  "expired",
  "deadline",
  "prerequisites",
] as const)("turn admission generation handoff handles %s", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f, true);
  const request = crypto.randomUUID();
  const options = { orgId: people.org, maxAttempts: 2 };
  await seedTurn(f, sandboxId, request);
  const payload = { requestId: request };
  const id = await store.enqueue("turn_dispatch", sandboxId, 2, request, payload, options);
  const advance = "update sandboxes set lifecycle_generation = lifecycle_generation + 1 where id = $1";
  let firstOwner: string | undefined;
  let handled: Job | undefined;
  const runner = createJobsRunner(
    {
      ...store,
      claim(kind, owner, seconds, concurrency) {
        firstOwner = owner;
        return store.claim(kind, owner, seconds, concurrency);
      },
    },
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job, context) {
          const handoff = context.handoffGeneration({
            async lockPrerequisites(tx) {
              if (scenario === "prerequisites")
                await tx.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
            },
            async advance(tx) {
              if (scenario === "not advanced") return;
              await tx.query("update account_turn_queue set state='dispatching' where sandbox_id=$1", [sandboxId]);
              await tx.query(advance, [sandboxId]);
              if (scenario === "interrupted") throw new Error("Admission interrupted.");
              if (scenario === "expired")
                await tx.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
              if (scenario === "deadline")
                await tx.query("update jobs set deadline_at = '-infinity' where id = $1", [id]);
            },
          });
          if (scenario === "interrupted") {
            await expect(handoff).rejects.toThrow("Admission interrupted.");
          } else if (scenario === "prerequisites") {
            await expect(handoff).rejects.toThrow("Turn job lease is no longer current.");
          } else if (scenario === "not advanced" || scenario === "expired" || scenario === "deadline") {
            await expect(handoff).rejects.toThrow("Turn admission did not advance its fenced generation.");
          } else {
            expect(await handoff).toBe("3");
            expect(await context.canDispatch()).toBe(true);
            expect(await store.renew(job, firstOwner!, 30)).toBe(true);
            if (scenario === "stale") await db.query(advance, [sandboxId]);
          }
          handled = job;
          if (scenario === "takeover") throw new Error("Receipt was not committed.");
          return { status: "done" };
        },
      },
    },
    () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(handled?.id).toBe(id);

  if (scenario === "takeover") {
    await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
    const owner = crypto.randomUUID();
    const successor = (await store.claim("turn_dispatch", owner, 30, 1))!;
    expect(successor).toMatchObject({ id, generation: "3", lease_epoch: "2" });
    expect(await store.complete(handled!, firstOwner!, { status: "done" })).toBe(false);
    expect(await store.complete(successor, owner, { status: "done" })).toBe(true);
    expect(await store.enqueue("turn_dispatch", sandboxId, 2, request, payload, options)).toBe(id);
  }
  const rolledBack = scenario !== "complete" && scenario !== "takeover" && scenario !== "stale";
  expect(
    (
      await db.query(
        `select j.state, j.generation::text as job_generation, s.lifecycle_generation::text as sandbox_generation
       from jobs j join sandboxes s on j.sandbox_id = s.id where j.id = $1`,
        [id],
      )
    ).rows,
  ).toEqual([
    {
      state: scenario === "stale" ? "failed" : "done",
      job_generation: rolledBack ? "2" : "3",
      sandbox_generation: rolledBack ? "2" : scenario === "stale" ? "4" : "3",
    },
  ]);
});

test("internal enqueue scopes the same key to each sandbox incarnation", async () => {
  const { people, store } = await fixture();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const enqueue = (id: string, generation: number) =>
    store.enqueue("sample", id, generation, "event", null, { orgId: people.org, maxAttempts: 1 });
  const ids = await Promise.all([enqueue(first, 1), enqueue(first, 2), enqueue(second, 1)]);
  expect(new Set(ids).size).toBe(3);
});

test("a failed completion transaction replays the same job and preserves its prior evidence", async () => {
  const { db, people, store } = await fixture();
  const id = await store.enqueue("sample", null, null, "event", null, { orgId: people.org, maxAttempts: 1 });
  const evidence = { phase: "observed" };
  await db.query("update jobs set outcome = $2 where id = $1", [id, evidence]);
  const effects = new Set<string>();
  const epochs: string[] = [];
  const run: Parameters<typeof createJobsRunner>[1][string]["run"] = async (job, { canDispatch }) => {
    expect(await canDispatch()).toBe(job.attempts === 1);
    effects.add(job.id);
    epochs.push(job.lease_epoch);
    if (job.attempts === 1)
      return {
        status: "done",
        commit: async () => {
          throw new Error("Crash before commit.");
        },
      };
    return { status: "fail", reason: "reconciled" };
  };
  const runner = () => createJobsRunner(store, { sample: { concurrency: 1, run } }, () => {});
  const first = runner();
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
  const successor = runner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(epochs).toEqual(["1", "2"]);
  expect([...effects]).toEqual([id]);
  expect((await db.query("select state, outcome from jobs where id = $1", [id])).rows).toEqual([
    { state: "failed", outcome: { reason: "reconciled", evidence } },
  ]);
});

async function registeredJobsLane() {
  await import("../modules.ts");
  const { jobsModule } = await import("../server-worker-modules.ts");
  const managed = new Map<string, LaneFactory>();
  jobsModule({ workers: { managed } } as Parameters<typeof jobsModule>[0]);
  return managed.get("jobs")!;
}

test("the registered jobs lane retries a lost seed reply and preserves the schedule across a restart", async () => {
  const { db, sql, store } = await fixture();
  const factory = await registeredJobsLane();
  let purges = 0;
  let seeds = 0;
  const services = {
    jobs: {
      ...store,
      async enqueue(...args: Parameters<typeof store.enqueue>) {
        const id = await store.enqueue(...args);
        if (++seeds === 1) {
          throw new Error("Seed reply lost.");
        }
        return id;
      },
    },
    options: { logError: () => {} },
    githubApp: null,
    config: {},
    modal: {
      launchCleanupJob: createModalLaunchCleanupJob(sql, async () => {
        throw new Error("Unexpected Modal cleanup.");
      }),
    },
    langfuse: {
      exportJob: {
        concurrency: 1,
        async run() {
          throw new Error("Unexpected Langfuse export.");
        },
      },
    },
    webhooks: {
      run: async () => {
        throw new Error("Unexpected webhook.");
      },
    },
    outputs: { enqueueCaptures: async () => {}, drain: async () => {} },
    sql,
    control: {
      applicationVault: {
        async purgeExpired() {
          purges++;
        },
      },
    },
  } as unknown as Parameters<LaneFactory>[0];
  const lane = factory(services)!;
  expect(await lane.reconcileOne(signal)).toBe(true);
  await lane.drain();
  expect(await lane.reconcileOne(signal)).toBe(false);
  const restarted = factory(services)!;
  expect(await restarted.reconcileOne(signal)).toBe(false);
  expect(purges).toBe(1);
  expect(seeds).toBe(3);
  const { rows } = await db.query(
    "select state, attempts, run_after > clock_timestamp() as delayed from jobs where kind = 'maintenance'",
  );
  expect(rows).toEqual([{ state: "queued", attempts: 0, delayed: true }]);
});

test("a failed recurring completion rolls back its schedule and the next lease replays the sweep", async () => {
  const { db, sql, store } = await fixture();
  const id = await seedRetentionMaintenance(store);
  const time = new Date("2100-01-01T00:00:00Z");
  let purges = 0;
  const handler = retentionMaintenanceJob(
    sql,
    {
      async purgeExpired() {
        purges++;
      },
    },
    () => {},
    () => time,
  );
  let retryExpiredCompletion: (() => Promise<boolean>) | undefined;
  const crashed = createJobsRunner(
    {
      ...store,
      complete(job, owner, result) {
        retryExpiredCompletion = () => store.complete(job, owner, result);
        return store.complete(job, owner, {
          ...result,
          async commit(tx) {
            await result.commit?.(tx);
            throw new Error("Completion interrupted before commit.");
          },
        });
      },
    },
    { maintenance: handler },
    () => {},
  );
  expect(await crashed.reconcileOne(signal)).toBe(true);
  await crashed.drain();
  const schedule = async () => (await db.query("select state, attempts, run_after from jobs where id = $1", [id])).rows;
  const beforeExpiry = await schedule();
  expect(beforeExpiry).toMatchObject([{ state: "leased", attempts: 1 }]);
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
  expect(await retryExpiredCompletion?.()).toBe(false);
  expect(await schedule()).toEqual(beforeExpiry);
  const successor = createJobsRunner(store, { maintenance: handler });
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(purges).toBe(2);
  expect(await schedule()).toEqual([{ state: "queued", attempts: 0, run_after: new Date(time.getTime() + 600_000) }]);
});

test("Boat stop takes over a staged capture and settles the resumed VM generation", async () => {
  const f = await fixture();
  const id = await sandbox(f, true);
  const key = btoa("\0".repeat(32));
  await f.db.query(
    "update sandboxes set provider='boat',status='stopping',stop_requested_at=now(),lifecycle_generation=4 where id=$1",
    [id],
  );
  const launch = await f.store.enqueue("launch", id, 1, "fixture", null, {
    orgId: f.people.org,
    maxAttempts: 1,
    deadline: new Date(Date.now() + 60_000),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  await f.db.query(`update public.jobs set state='done',outcome=$2::jsonb where id=$1`, [
    launch,
    JSON.stringify({ boat_authority: {}, modal_machine: { entry: { machineId: id } } }),
  ]);
  const resume = await f.store.enqueue("resume", id, 3, "boat", null, {
    orgId: f.people.org,
    maxAttempts: 1,
    deadline: new Date(Date.now() + 60_000),
  });
  await f.db.query(
    `update public.jobs set state='failed',outcome='{"boat_restore_dispatched":true}'::jsonb where id=$1`,
    [resume],
  );
  await f.sql.transaction!((tx) => enqueueBoatStop(tx, id, 4));
  let captures = 0;
  let stops = 0;
  let active = false;
  let crash = new AbortController();
  const now = Date.now();
  const handler = createBoatStop(
    f.sql,
    key,
    "fixture",
    () => now,
    async (target, authorize) => {
      expect(target).toMatchObject({ sandboxId: id, machineId: id, generation: 4, launchGeneration: 1 });
      return {
        machine: {
          observe: async () => (active ? { kind: "present", machine: target, phase: "running" } : { kind: "absent" }),
          async stop(request) {
            await authorize();
            expect(request).toMatchObject({ sandboxId: id, machineId: id, generation: 4, retain: true });
            expect(captures).toBe(1);
            if (++stops === 1) {
              crash.abort();
              throw new Error("Interrupted before remote dispatch");
            }
            return { sandboxId: id, generation: 4, kind: "disk", ref: id };
          },
        },
        outputs: {
          async listOutputEntries() {
            captures++;
            return [{ name: "late.txt", size: 11, revision: "1:2:3:4" }];
          },
          async readOutputChunk() {
            return new TextEncoder().encode("late output");
          },
        },
      };
    },
  );
  const run = (job: Job, owner: string) =>
    handler(job, {
      signal: crash.signal,
      async canDispatch(tx) {
        return (await f.store.inspect(job, owner, tx)) === "dispatch";
      },
      async handoffGeneration() {
        throw new Error("Unexpected handoff");
      },
    });

  const archiveOwner = crypto.randomUUID();
  const archive = (await f.store.claim("stop", archiveOwner, 30, 1))!;
  const unresolved = await run(archive, archiveOwner);
  expect(unresolved.status).toBe("retry");
  expect(await f.store.complete(archive, archiveOwner, unresolved)).toBe(true);
  expect(stops).toBe(0);
  expect((await f.db.query("select status::text, stopped_at from sandboxes where id=$1", [id])).rows).toEqual([
    { status: "stopping", stopped_at: null },
  ]);
  await f.db.query("update jobs set run_after=now() where id=$1", [archive.id]);
  active = true;

  const firstOwner = crypto.randomUUID();
  const first = (await f.store.claim("stop", firstOwner, 30, 1))!;
  expect(first).toMatchObject({ sandbox_id: id, generation: "4", outcome: null });
  await expect(run(first, firstOwner)).rejects.toThrow();
  expect((await f.db.query("select outcome ? 'output' as staged from jobs where id=$1", [first.id])).rows).toEqual([
    { staged: true },
  ]);
  await f.db.query("update jobs set lease_until=now()-interval '1 second' where id=$1", [first.id]);
  crash = new AbortController();
  const nextOwner = crypto.randomUUID();
  const replay = (await f.store.claim("stop", nextOwner, 30, 1))!;
  const result = await run(replay, nextOwner);
  expect(result.status).toBe("done");
  expect(await f.store.complete(replay, nextOwner, result)).toBe(true);
  expect(
    (await f.db.query("select status::text,stopped_at is not null as exited from sandboxes where id=$1", [id])).rows,
  ).toEqual([{ status: "stopped", exited: true }]);
  expect((await f.db.query("select kind from jobs where sandbox_id=$1 and kind='outputs_capture'", [id])).rows).toEqual(
    [{ kind: "outputs_capture" }],
  );
  const output = (await f.store.claim("outputs_capture", nextOwner, 30, 1))!;
  const publication = await createSandboxOutputs(f.sql, key, async () => ({})).captureJob.run(output, {
    signal: crash.signal,
    canDispatch: async () => true,
  });
  expect(await f.store.complete(output, nextOwner, publication)).toBe(true);
  expect((await f.db.query("select name from sandbox_outputs where sandbox_id=$1", [id])).rows).toEqual([
    { name: "late.txt" },
  ]);
  expect(stops).toBe(2);
});

test("a failed Boat VM observed absent under its pinned account releases capacity", async () => {
  const f = await fixture();
  const id = await sandbox(f, true);
  await f.db.query("update sandboxes set status='failed',stop_requested_at=now() where id=$1", [id]);
  const launch = await f.store.enqueue("launch", id, 1, "fixture", null, {
    orgId: f.people.org,
    maxAttempts: 1,
    deadline: new Date(Date.now() + 60_000),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  await f.db.query("update jobs set state='done',outcome=$2::jsonb where id=$1", [
    launch,
    JSON.stringify({
      boat_authority: { backendId: "account", scope: "org" },
      modal_machine: { entry: { machineId: id } },
    }),
  ]);
  await f.db.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
    id,
    f.openaiCredentialId,
  ]);
  await f.sql.transaction!((tx) => enqueueBoatStop(tx, id, 2));
  expect(
    await runBoatStop(f.sql, {
      ...archivedBoat(false),
      observe: async () => ({ kind: "absent", receipt: { operation: "delete" } }),
    }),
  ).toBe("done");
  expect(
    (await f.db.query("select stopped_at is not null as confirmed from sandboxes where id=$1", [id])).rows,
  ).toEqual([{ confirmed: true }]);
  expect((await f.db.query("select 1 from account_agent_reservations where sandbox_id=$1", [id])).rows).toEqual([]);
});
