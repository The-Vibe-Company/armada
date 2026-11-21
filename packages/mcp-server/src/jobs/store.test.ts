import { expect, test } from "bun:test";
import { createSqlVaultStore, decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import { type ModalMachineOptions, scopeKey } from "@armada/provider-modal";
import { rowOnlyDatabase } from "../../test/row-only-database.ts";
import { createTurnDispatchJob, type DispatchTurn } from "../account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../account-turn-queue.ts";
import { readLogs } from "../control-logs.ts";
import { createSqlData } from "../data.ts";
import { createGoldenRuntimeEnvironment } from "../golden-runtime-environment.ts";
import { launchCredentials } from "../launch-credentials.ts";
import { createOrdinaryLaunchReceipts } from "../ordinary-launch-receipts.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "../retention-maintenance.ts";
import { createRuntimeCommands } from "../runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "../runtime-enrolment.ts";
import { createRuntimeEvents } from "../runtime-events.ts";
import { createRuntimeGitHub } from "../runtime-github.ts";
import { createModalJobReader, createModalLogReader } from "../runtime-history.ts";
import { createRuntimeMcp, type RuntimeMcp } from "../runtime-mcp.ts";
import { createSandboxLifecycle } from "../sandbox-lifecycle.ts";
import type { LaneFactory } from "../server-worker-modules.ts";
import { sqlOver } from "../sql.ts";
import { callSharedTool } from "../tool-api.ts";
import { runtimeWakes } from "../wake-bus.ts";
import {
  admitModalLaunch as admitModalLaunchWithMcp,
  createModalInitialTurnJob,
  createModalLaunchCleanupJob,
  createModalLaunchJob,
  MODAL_INITIAL_TURN,
  type ModalLaunchAdmission,
  modalLaunchTicketGuard,
  runModalLaunch,
} from "./modal-launch.ts";
import { createJobsRunner, type Job, type JobContext } from "./runner.ts";
import { createJobsStore, JOBS_WAKE, withJobLease } from "./store.ts";

const database = rowOnlyDatabase();
const signal = new AbortController().signal;

async function fixture() {
  const { db, people, openaiCredentialId } = await database();
  const sql = sqlOver({
    unsafe: async (query, params) => (await db.query(query, params)).rows,
    begin: (work) =>
      db.transaction((tx) => work({ unsafe: async (query, params) => (await tx.query(query, params)).rows })),
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

async function unboundModalSandbox(f: Awaited<ReturnType<typeof fixture>>) {
  const goldenId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into goldens (id, org_id, owner_id, name, visibility, provider, modal_workspace, modal_environment, modal_app_id)
     values ($1, $2, $3, 'modal-launch', 'private', 'modal', 'workspace', 'main', 'ap-test')`,
    [goldenId, f.people.org, f.people.owner],
  );
  await f.db.query(
    `insert into sandboxes (id, golden_id, org_id, owner_id, harness, provider, status, lifecycle_generation, runtime_transport)
     values ($1, $2, $3, $4, 'codex', 'modal', 'starting', 2, 'dialout')`,
    [id, goldenId, f.people.org, f.people.owner],
  );
  return id;
}

const launchEncryptionKey = btoa("\0".repeat(32));

const workspaceConfig = {
  repos: [{ url: "https://github.com/example/workspace", dir: "workspace", branch: "main" }],
  init: ["printf initialized"],
};

async function modalAdmissionFixture() {
  const f = await fixture();
  const goldenId = crypto.randomUUID();
  await f.db.query(
    `insert into goldens
       (id, org_id, owner_id, name, visibility, provider, modal_workspace, modal_environment, modal_app_id, provider_snapshot_id, config)
     values ($1,$2,$3,'modal-admission','private','modal','workspace','main','ap-test','snapshot',$4)`,
    [goldenId, f.people.org, f.people.owner, workspaceConfig],
  );
  const scope = scopeKey({
    orgId: f.people.org,
    userId: f.people.owner,
    visibility: "private",
    binding: { workspace: "workspace", environment: "main", appId: "ap-test" },
  });
  await f.db.query(
    `insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record)
     values($1,$2,$3,'private','builder','builder','{}')`,
    [scope, f.people.org, f.people.owner],
  );
  await f.db.query(
    `insert into modal_images(scope,name,source_id,record)
     values($1,'snapshot','builder','{"info":{"status":"ready"},"imageId":"im-snapshot"}')`,
    [scope],
  );
  const input: ModalLaunchAdmission = {
    orgId: f.people.org,
    ownerId: f.people.owner,
    request: { key: "launch-key", digest: "launch-digest" },
    sandbox: { goldenId, harness: "codex", model: "gpt-5", reasoningEffort: "medium", effectiveTtlSeconds: 1800 },
    allocation: { source: { kind: "snapshot", ref: "snapshot" }, size: null, computeTtlSeconds: 3600 },
    initialPrompt: "initial instructions",
    deadline: new Date("2100-01-01T00:00:00Z"),
    maxAttempts: 3,
  };
  return { ...f, input };
}

test("Modal backfill preserves accepted, refused and unresolved ordinary keys without scheduling work", async () => {
  const { db, sql, input, store } = await modalAdmissionFixture();
  const { request: _request, ...unkeyed } = input;
  const accepted = (await admitModalLaunch(sql, launchEncryptionKey, unkeyed)).sandbox.id;
  await db.query("delete from jobs where sandbox_id=$1", [accepted]);

  const key = 'historical-launch-"\\雪\n';
  const requests = [
    { key: `${key}accepted\ud800`, digest: "historical-accepted", id: accepted },
    { key: `${key}refused`, digest: "historical-refused", id: crypto.randomUUID() },
    { key: `${key}unknown`, digest: "historical-unknown", id: crypto.randomUUID() },
    { key: `${key}unattributed`, digest: "historical-unattributed", id: crypto.randomUUID() },
    { key: `${key}boat`, digest: "historical-boat", id: crypto.randomUUID() },
  ] as const;
  const [success, refusal, unknown, unattributed, boat] = requests;
  for (const request of requests) {
    await db.query(
      `insert into ordinary_launch_receipts
        (id, org_id, owner_id, request_key, fingerprint, authority, response, failure)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        request.id,
        input.orgId,
        input.ownerId,
        request === success ? `${key}accepted\ufffd` : request.key,
        request.digest,
        request === unattributed ? null : { target: { provider: request === boat ? "boat" : "modal" } },
        request === success ? { sandbox: { id: accepted, status: "ready" }, promptId: "prior-prompt" } : null,
        request === refusal ? { kind: "golden", code: "unsupported" } : null,
      ],
    );
  }

  await db.query("delete from jobs where sandbox_id=$1", [boat.id]);

  for (let replay = 0; replay < 2; replay++) {
    const { rows } = await db.query("select backfill_modal_launch_receipts()::int as verified");
    expect(rows).toEqual([{ verified: requests.length }]);
  }
  const admit = ({ key, digest }: { key: string; digest: string }) =>
    admitModalLaunch(sql, launchEncryptionKey, { ...input, request: { key, digest } });
  expect(await admit(success)).toEqual({ sandbox: { id: accepted, status: "starting" } });
  await expect(admit(refusal)).rejects.toMatchObject({ code: "unsupported" });
  for (const receipt of [unknown, unattributed, boat]) {
    await expect(admit(receipt)).rejects.toMatchObject({ code: "outcome_unknown" });
  }
  await expect(admit({ ...success, digest: "changed" })).rejects.toMatchObject({ code: "conflict" });
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

test("Modal backfill rolls back when a destination key belongs to a different receipt", async () => {
  const { db, sql, input } = await modalAdmissionFixture();
  await admitModalLaunch(sql, launchEncryptionKey, {
    ...input,
    request: { key: "colliding-launch-key", digest: "new-digest" },
  });
  await db.query(
    `insert into ordinary_launch_receipts (id, org_id, owner_id, request_key, fingerprint)
     values ($1,$3,$4,'another-historical-key','old-digest'), ($2,$3,$4,'colliding-launch-key','new-digest')`,
    [crypto.randomUUID(), crypto.randomUUID(), input.orgId, input.ownerId],
  );
  await expect(db.query("select backfill_modal_launch_receipts()")).rejects.toThrow(
    "Modal launch receipt backfill conflicts",
  );
  expect((await db.query("select count(*)::int as count from jobs where kind='launch'")).rows).toEqual([{ count: 1 }]);
});

test.each(["boat", "modal"] as const)("a %s reservation excludes the competing launch producer", async (first) => {
  const { db, input, sql } = await modalAdmissionFixture();
  const key = 'shared-launch-key-"\\雪\n';
  const actor = { orgId: input.orgId, userId: input.ownerId };
  const receipts = createOrdinaryLaunchReceipts(sql);
  const boat = (dispatch: (id: string) => Promise<string>) =>
    receipts.run(actor, key, { golden: "boat-golden" }, dispatch, {
      target: { provider: "boat", orgId: actor.orgId, visibility: "org", modal: null },
      backendId: "boat",
      management: { scope: "org", ownerId: actor.orgId },
    });
  const modal = (digest: string) => admitModalLaunch(sql, launchEncryptionKey, { ...input, request: { key, digest } });

  if (first === "boat") {
    const boatId = await boat(async (id) => id);
    const {
      rows: [receipt],
    } = await db.query<{ fingerprint: string }>("select fingerprint from ordinary_launch_receipts where id=$1", [
      boatId,
    ]);
    await expect(modal(receipt!.fingerprint)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect((await db.query("select id from sandboxes")).rows).toEqual([]);
    expect((await db.query("select backfill_modal_launch_receipts()::int as verified")).rows).toEqual([
      { verified: 1 },
    ]);
    return;
  }

  const { sandbox } = await modal("modal-digest");
  await expect(
    boat(async () => {
      throw new Error("Competing Boat provider must never be called");
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await db.query("select id from ordinary_launch_receipts")).rows).toEqual([]);
  expect((await db.query("select id from sandboxes")).rows).toEqual([{ id: sandbox.id }]);
});

function admitModalLaunch(sql: Sql, key: string, input: ModalLaunchAdmission) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key);
  const mcp = createRuntimeMcp({ sql, key, origin: "https://armada.example", commands });
  return admitModalLaunchWithMcp(sql, key, input, mcp);
}

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
  const admitted = await admitModalLaunch(sql, launchEncryptionKey, input);
  await db.query("update mcp_connections set default_for_launch=false where id=$1", [connectionId]);
  const disconnected = await launchConnection(db, people);
  await db.query("update mcp_grants set status='not_connected' where connection_id=$1", [disconnected]);
  expect(await admitModalLaunch(sql, launchEncryptionKey, input)).toEqual(admitted);
  await admitModalLaunch(sql, launchEncryptionKey, {
    ...input,
    request: { key: "no-connections", digest: "explicit-empty" },
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

test.each(["active secret", "revoked secret", "changed snapshot", "changed connection"] as const)(
  "pinned Modal admission handles %s before dispatch",
  async (status) => {
    const { sql, db, people, input, openaiCredentialId } = await modalAdmissionFixture();
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
            id: input.sandbox.goldenId,
            provider: "modal",
            providerSnapshotId: input.allocation.source.ref,
            config: workspaceConfig,
            modal: { workspace: "workspace", environment: "main", appId: "ap-test" },
          },
          account: { id: openaiCredentialId, version: 1 },
          definition: {
            provider: "modal",
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
      sandbox: { ...input.sandbox, credentialId: openaiCredentialId, credentialVersion: 1 },
    };
    const admit = () => admitModalLaunch(sql, launchEncryptionKey, pinned);
    if (status !== "active secret") {
      if (status === "revoked secret") {
        await db.query("update application_secrets set status='revoked',value_enc=null where id=$1", [secret!.id]);
        await expect(admit()).rejects.toMatchObject({ code: "conflict", reason: "secret_unavailable" });
      } else if (status === "changed connection") {
        await db.query("update mcp_grants set version=version+1 where connection_id=$1", [connectionId]);
        await expect(admit()).rejects.toMatchObject({ code: "conflict" });
      } else {
        await db.query("update goldens set provider_snapshot_id='replacement' where id=$1", [pinned.sandbox.goldenId]);
        await db.query(
          `insert into modal_images(scope,name,source_id,record)
           select scope,'replacement',source_id,record from modal_images where name='snapshot'`,
        );
        pinned.allocation = { ...pinned.allocation, source: { kind: "snapshot", ref: "replacement" } };
        await expect(admit()).rejects.toThrow("Frozen Modal template snapshot or App binding changed.");
      }
      expect((await db.query("select id from sandboxes where id=$1", [sandboxId])).rows).toEqual([]);
      expect((await db.query("select id from jobs where sandbox_id=$1", [sandboxId])).rows).toEqual([]);
      return;
    }
    const accepted = { sandbox: { id: sandboxId, status: "starting" } } as const;
    expect(await admit()).toEqual(accepted);
    expect(await admit()).toEqual(accepted);
    const setup = await createJobsStore(sql, launchEncryptionKey).claim(MODAL_INITIAL_TURN, crypto.randomUUID(), 30, 1);
    expect(setup?.payload).toMatchObject({ skills: ["example/tool@1.0.0"] });
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
  const { sandbox } = await admitModalLaunch(sql, launchEncryptionKey, input);
  expect(sandbox).toEqual({ id: expect.any(String), status: "starting" });
  expect(
    (
      await db.query(
        `select s.provider_sandbox_id, s.lifecycle_generation::text as generation, s.status, p.snapshot_id,
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
      effective_ttl_seconds: 1800,
      expiry_seconds: 1800,
    },
  ]);
  const job = await store.claim("launch", crypto.randomUUID(), 30, 1);
  expect(job).toMatchObject({
    sandbox_id: sandbox.id,
    generation: "1",
    payload: {
      allocation: { ...input.allocation, source: { kind: "snapshot", ref: "im-snapshot" } },
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
      request: { key: input.request!.key, digest: "different" },
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
  | "create response"
  | "bootstrap dispatch"
  | "bootstrap response"
  | "image lookup"
  | "runtime ticket"
  | "termination response"
  | "machine poll"
  | "cleanup preparation";

async function modalLaunchFixture(initial?: Awaited<ReturnType<typeof modalAdmissionFixture>>) {
  const f = initial ?? (await fixture());
  const id = initial
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
  let visible = true;
  let terminations = 0;
  let cleanupPreparations = 0;
  let closedClients = 0;
  let modalCredentialCurrent = true;
  let tags: Record<string, string> = {};
  const bootstrapped: string[] = [];
  const enrolments = createRuntimeEnrolments(f.sql, launchEncryptionKey);
  let enrolmentToken: string;
  let activeRuntime: Awaited<ReturnType<typeof enrolments.enrol>> | undefined;
  const makeRunner = (atStep?: (step: ModalLaunchStep) => void | Promise<void>, jobsSql = f.sql, enrol = true) => {
    const sandbox = {
      sandboxId: "physical",
      getTags: async () => tags,
      poll: async () => {
        observed++;
        await atStep?.("machine poll");
        return terminations ? 0 : null;
      },
      async terminate() {
        terminations++;
        await atStep?.("termination response");
      },
      async exec() {
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
        async create(_app: unknown, _image: unknown, options: { tags: Record<string, string> }) {
          allocations++;
          tags = options.tags;
          await atStep?.("create response");
          return sandbox;
        },
        fromName: async () => {
          if (!visible) throw new Error("Allocation lookup unavailable");
          return sandbox;
        },
        fromId: async () => sandbox,
      },
    } as unknown as ModalMachineOptions["client"];
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
        configuration: {},
        serverUrl: "https://armada.invalid",
        artifact: { sha256: "a".repeat(64), bytes: 1 },
        cacheDir: "/home/user/runtime-cache",
        async lockPrerequisites() {},
        async checkAccountPin() {},
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
              canUseModalCredential: async () => modalCredentialCurrent,
              close() {
                closedClients++;
              },
            };
          },
          async (target) => ({ ...(await prepareRuntimeTicket()), ...modalLaunchTicketGuard(target) }),
        )
      : {
          concurrency: 1,
          run(job: Job, context: JobContext) {
            return runModalLaunch(jobsSql, launchEncryptionKey, job, context, () => ({
              allocation: { source: { kind: "image", ref: "image" }, size: null, computeTtlSeconds: 600 },
              bindingRef: job.id,
              machine,
              canUseModalCredential: async () => modalCredentialCurrent,
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
    effects: () => ({ allocations, observed, bootstrapped }),
    cleanupEffects: () => ({ terminations, cleanupPreparations }),
    closedClients: () => closedClients,
    revokeModalCredential: () => {
      modalCredentialCurrent = false;
    },
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
    options: { logError: () => {} },
    control: {},
    langfuse: { exportJob: { concurrency: 1 } },
    webhooks: {},
    outputs: { drain: async () => {}, captureJob: { concurrency: 1 } },
    modal: { launchCleanupJob: { concurrency: 1 } },
  } as unknown as Parameters<LaneFactory>[0])!;
}

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
    if (crash === "before")
      await expect(
        queue.accept(
          { userId: f.people.owner, orgs: [{ orgId: f.people.org, role: "member" }], via: "service" },
          { id, prompt: "Follow up" },
        ),
      ).rejects.toThrow("Modal launch setup is still in progress.");
    expect((await turns()).rows).toHaveLength(crash === "after" ? 1 : 0);
    expect((await dispatchJobs()).rows).toHaveLength(crash === "after" ? 1 : 0);

    await db.query("update jobs set lease_until='-infinity' where id=$1", [intent!.id]);
    await claim(await modalFirstTurnLane(f, queue));
    expect(await intentState()).toEqual({ state: "done", attempts: crash === "after" ? 4 : 2 });
    const { rows } = await turns();
    expect(rows.map(({ request_id }) => request_id)).toEqual([intent!.id]);
    expect(JSON.parse(await decryptSecret(rows[0]!.input_enc, launchEncryptionKey))).toMatchObject({
      prompt: admission.input.initialPrompt,
    });
    expect((await dispatchJobs()).rows).toEqual([{ kind: "turn_dispatch" }]);
  },
);

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
    if (scenario === "acknowledgement lost")
      await expect(sendFollowUp()).rejects.toThrow("Modal launch setup is still in progress.");
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
      if (scenario === "secret revoked") await expect(sendFollowUp()).rejects.toThrow("Modal launch setup failed.");
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

test.each(["allocated", "deleting", "deleted"] as const)(
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

test("owner stop after a lost Modal create reply leaves the exact allocation for replacement cleanup", async () => {
  const { f, id, jobId, makeRunner, effects, cleanupEffects } = await modalLaunchFixture(await modalAdmissionFixture());
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
  expect(await callSharedTool(context, "stop", { id })).toEqual({ id, status: "starting" });
  expect(cleanupEffects().terminations).toBe(0);
  const stopped = await data.sandboxes.get(id);
  expect(stopped?.status).toBe("starting");
  expect(stopped?.stopRequestedAt).toBeTruthy();

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
  const { f, id, makeRunner, activeRuntime } = await modalLaunchFixture(await modalAdmissionFixture());
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
  const follow = (cursor?: string, afterPage?: () => Promise<unknown>) =>
    readLogs(
      {
        logs: async (actor, id) => {
          const sandbox = (await data.sandboxes.get(id))!;
          const provider = await logReader(sandbox, actor);
          return {
            provider: {
              ...provider,
              async events(request) {
                const page = await provider.events(request);
                await afterPage?.();
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
    status: "ready",
    prompt: null,
    settled: false,
    statusMessage: "Modal launch setup is still in progress.",
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

  expect(await follow(active.cursor!, () => append(2, "finished"))).toMatchObject({ events: [], settled: false });
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

test("a replacement Modal cleanup claimant continues after client preparation fails", async () => {
  const { f, id, makeRunner, cleanupEffects } = await failedModalLaunchFixture();
  const initial = makeRunner((step) => {
    if (step === "cleanup preparation") throw new Error("Modal credentials temporarily unavailable.");
  });
  expect(await initial.reconcileOne(signal)).toBe(true);
  await initial.drain();
  expect(cleanupEffects()).toEqual({ terminations: 0, cleanupPreparations: 1 });
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1 and kind='delete'", [id]);
  const successor = makeRunner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(cleanupEffects()).toEqual({ terminations: 1, cleanupPreparations: 2 });
  expect((await f.db.query("select state from jobs where sandbox_id=$1 and kind='delete'", [id])).rows).toEqual([
    { state: "done" },
  ]);
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

test.each(["create response", "bootstrap dispatch", "bootstrap response"] as const)(
  "a replacement Modal launch runner completes after losing the %s",
  async (failure) => {
    const { f, id, jobId, makeRunner, effects } = await modalLaunchFixture(await modalAdmissionFixture());
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
    if (failure === "bootstrap dispatch") {
      await f.db.query("update runtime_enrolments set enrolment_expires_at='-infinity' where sandbox_id=$1", [id]);
    }

    expect(await lifecycle.reconcileOne()).toBe(false);
    const successor = makeRunner();
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual(["physical"]);
    if (failure === "create response") expect(effects().observed).toBe(1);
    expect(
      (
        await f.db.query("select s.status, j.state from sandboxes s join jobs j on j.sandbox_id=s.id where j.id=$1", [
          jobId,
        ])
      ).rows,
    ).toEqual([{ status: "ready", state: "done" }]);
  },
);

test("interrupted Modal enrolment rolls back readiness and leaves its ticket usable", async () => {
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
  await expect(enrolPending()).resolves.toMatchObject({ sandboxId: id });
  expect((await f.db.query("select status from sandboxes where id=$1", [id])).rows).toEqual([{ status: "ready" }]);
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
  const lateEnrolment: Sql = {
    ...f.sql,
    async transaction(work) {
      let readFailureTarget = false;
      const result = await f.sql.transaction!(async (tx) =>
        work({
          ...tx,
          async query<T>(query: string, params?: unknown[]) {
            if (query.includes("as journaled_id")) readFailureTarget = true;
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
] as const)(
  "a Modal launch whose %s during %s cannot dispatch the prepared operation",
  async (change, interruptedAt) => {
    const { f, jobId, makeRunner, effects, revokeModalCredential } = await modalLaunchFixture();
    const runner = makeRunner(async (step) => {
      if (step !== interruptedAt) return;
      if (change === "Modal credential is revoked") revokeModalCredential();
      else await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(interruptedAt === "image lookup" ? 0 : 1);
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
  ["unfinished enrolled runtime resume", 3, "resume", "infinity", true, false],
  ["unfinished unenrolled runtime resume", 3, "resume", "infinity", true, false],
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
  const pendingWake = activity === "resume" && scenario.startsWith("unfinished");
  await db.query(`update sandboxes set lifecycle_generation=$2, activity_lease_id=$3, activity_until=$4 where id=$1`, [
    sandboxId,
    scenario === "runtime request advanced after claim" ? 2 : generation,
    activity === "request" || pendingWake ? requestId : activity === "other" ? crypto.randomUUID() : null,
    activity === "request" || activity === "other" || pendingWake ? "infinity" : null,
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
    const finished = !pendingWake;
    await db.query(
      `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
       values ($1,$2,$3,case when $4 then repeat('a',64) end)`,
      [
        sandboxId,
        generation,
        scenario === "older-epoch runtime resume" ? 3 : 2,
        scenario !== "unfinished unenrolled runtime resume",
      ],
    );
    await db.query(
      `insert into runtime_resumes (sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,
         conversation_id,model,reasoning_effort,phase,verified_at,receipt)
       values ($1,$2,1,2,0,repeat('a',64),'fixture','fixture','low',
         case when $3 then 'complete' else 'dispatched' end,
         case when $3 then now() end,case when $3 then '{"resumed":true}'::jsonb end)`,
      [sandboxId, scenario === "unrelated runtime resume" ? crypto.randomUUID() : requestId, finished],
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
    scenario === "unfinished enrolled runtime resume" ||
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

test.each(["missing", "pending", "accepted", "refused", "unrelated"] as const)(
  "stopped Docker dispatch resets only without its own bootstrap intent (%s)",
  async (intent) => {
    const { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id } =
      await interruptedDockerTurn("stopped");
    const { db, people, store } = f;
    if (intent !== "missing")
      await db.query(
        `insert into docker_resume_claims
         (request_id,sandbox_id,host_id,installation_id,generation,actor_id,lifecycle_generation,accepted)
         values ($1,$2,$3,$4,$5,$6,2,$7)`,
        [
          intent === "unrelated" ? crypto.randomUUID() : requestId,
          sandboxId,
          hostId,
          installationId,
          dockerGeneration,
          people.owner,
          intent === "pending" ? null : intent === "accepted",
        ],
      );
    const owner = crypto.randomUUID();
    const claim = await store.claim("turn_dispatch", owner, 30, 1);
    expect(claim).toMatchObject({ id, generation: "2", payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe("dispatch");
    const reset = intent === "missing" || intent === "unrelated";
    expect(
      (
        await db.query(
          `select q.state, (q.dispatch_generation is not null or q.dispatch_until is not null) as dispatch_recorded,
             exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
             from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: reset ? "queued" : "dispatching", dispatch_recorded: !reset, reserved: !reset }]);
  },
);

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
  ["pending while starting", "starting", null, true],
  ["pending after readiness", "running", null, false],
  ["obsolete prompt with only a pending host job", "running", null, false],
  ["obsolete prompt with only a resume claim", "running", null, false],
  ["completed before prompt", "running", "completed", true],
  ["completed without a deadline", "running", "completed", true],
  ["pending without a deadline", "running", null, false],
  ["failed", "starting", "failed", false],
  ["refused", "starting", null, false],
  ["revoked host", "starting", null, false],
  ["unrelated request", "starting", "failed", false],
  ["old actor epoch", "starting", null, false],
  ["old source generation", "starting", null, false],
  ["physical claim pending", "starting", null, false],
  ["prompt already submitted", "running", "completed", false],
] as const)(
  "a stale turn resumes only from its live Docker host job (%s)",
  async (scenario, status, outcome, recover) => {
    const turn = await turnFixture();
    const { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id } = await interruptedDockerTurn(
      status,
      turn,
    );
    const { db, people, store } = f;
    const resumeId = scenario === "unrelated request" ? crypto.randomUUID() : requestId;
    const hostJobOnly = scenario === "obsolete prompt with only a pending host job";
    const resumeClaimOnly = scenario === "obsolete prompt with only a resume claim";
    if (!hostJobOnly)
      await db.query(
        `insert into docker_resume_claims
       (request_id,sandbox_id,host_id,installation_id,generation,actor_id,lifecycle_generation,accepted)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          resumeId,
          sandboxId,
          hostId,
          installationId,
          dockerGeneration,
          people.owner,
          scenario === "old source generation" ? 1 : 2,
          scenario === "physical claim pending" ? null : true,
        ],
      );
    if (!resumeClaimOnly)
      await db.query(
        `insert into docker_host_jobs
       (request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,
        outcome,completed_at,refused_resume_generation)
     select $1,$2,decode(repeat('00',29),'hex'),$3,$4,epoch + $5::bigint,'resume',$6,
       case when $6::text is not null then now() end, $7
     from mcp_actor_epochs where org_id=$8 and user_id=$4`,
        [
          resumeId,
          hostId,
          sandboxId,
          people.owner,
          scenario === "old actor epoch" ? -1 : 0,
          outcome,
          scenario === "refused" ? 3 : null,
          people.org,
        ],
      );
    if (scenario === "revoked host") await db.query("update docker_hosts set revoked_at=now() where id=$1", [hostId]);
    if (hostJobOnly || resumeClaimOnly) {
      await db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
         values ($1,3,2,repeat('a',64))`,
        [sandboxId],
      );
      await db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
         values ($1,$2,1,''::bytea,''::bytea)`,
        [sandboxId, `docker_prompt_${requestId}`],
      );
    }
    if (scenario === "prompt already submitted") {
      await db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc) values ($1,$2,1,''::bytea)`,
        [sandboxId, `docker_prompt_${requestId}`],
      );
    }
    if (scenario.endsWith("without a deadline"))
      await db.query("update account_turn_queue set dispatch_until=null where request_id=$1", [requestId]);
    if (scenario === "completed without a deadline") {
      await db.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [
        sandboxId,
        f.openaiCredentialId,
      ]);
      await db.query("update account_turn_queue set input_enc=$2 where request_id=$1", [
        requestId,
        await encryptSecret(
          JSON.stringify({ id: sandboxId, request_id: requestId, prompt: "queued" }),
          btoa("\0".repeat(32)),
        ),
      ]);
      const interrupted = createJobsStore(
        {
          ...f.sql,
          transaction: (work) =>
            f.sql.transaction!(async (tx) => {
              await work(tx);
              throw new Error("Connection lost before Docker retarget committed.");
            }),
        },
        btoa("\0".repeat(32)),
      );
      await expect(interrupted.claim("turn_dispatch", crypto.randomUUID(), 30, 1)).rejects.toThrow("Connection lost");
      expect((await db.query("select generation::text,state from jobs where id=$1", [id])).rows).toEqual([
        { generation: "2", state: "leased" },
      ]);
      await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);

      const sent: string[] = [];
      const runner = turn.runnerFor(async (_caller, input) => {
        sent.push(input.request_id!);
        return { status: "accepted" };
      });
      expect(await runner.reconcileOne(signal)).toBe(true);
      await runner.drain();
      expect(sent).toEqual([requestId]);
      expect(
        (
          await db.query(
            `select j.generation::text,j.state as job_state,q.state as receipt_state
           from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id
           where j.id=$1 and q.request_id=$2`,
            [id, requestId],
          )
        ).rows,
      ).toEqual([{ generation: "3", job_state: "done", receipt_state: "admitted" }]);
      return;
    }
    if (recover) {
      await db.query("update account_turn_queue set dispatch_until='2100-01-01T00:00:00Z' where request_id=$1", [
        requestId,
      ]);
      const owner = crypto.randomUUID();
      const stale = (await store.claim("turn_dispatch", owner, 30, 1))!;
      expect(await store.inspect(stale, owner)).toBe("stale");
      const interrupted = createJobsStore(
        {
          ...f.sql,
          transaction: (work) =>
            f.sql.transaction!(async (tx) => {
              await work(tx);
              throw new Error("Connection lost before Docker resume deferral committed.");
            }),
        },
        btoa("\0".repeat(32)),
      );
      await expect(interrupted.retireStale(stale, owner, "no_dispatch")).rejects.toThrow("Connection lost");
      expect(await store.inspect(stale, owner)).toBe("stale");
      await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);

      const successor = crypto.randomUUID();
      const claim = (await store.claim("turn_dispatch", successor, 30, 1))!;
      await store.retireStale(claim, successor, "no_dispatch");
      expect(
        (
          await db.query(
            `select j.state, j.attempts, j.generation::text, j.lease_owner,
                    (j.run_after=q.dispatch_until) as waits_for_receipt
             from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id
             where j.id=$1 and q.request_id=$2`,
            [id, requestId],
          )
        ).rows,
      ).toEqual([{ state: "queued", attempts: 1, generation: "2", lease_owner: null, waits_for_receipt: true }]);
      expect(await store.claim("turn_dispatch", crypto.randomUUID(), 30, 1)).toBeFalsy();
      await db.query("update account_turn_queue set dispatch_until='-infinity' where request_id=$1", [requestId]);
      await db.query("update jobs set run_after='-infinity' where id=$1", [id]);
    }
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    expect(job).toMatchObject({ id, generation: recover ? "3" : "2", payload: { requestId } });
    const failedWake = scenario === "failed" || scenario === "refused";
    expect(await store.inspect(job, owner)).toBe(recover ? "dispatch" : failedWake ? "lost" : "stale");
    if (failedWake)
      expect((await db.query("select state, outcome->>'reason' as reason from jobs where id=$1", [id])).rows).toEqual([
        { state: "failed", reason: "docker_wake_failed" },
      ]);
    const lateAck = scenario === "pending after readiness" || scenario === "pending without a deadline";
    const rollback = scenario === "pending without a deadline";
    let retireOwner = owner;
    let retireJob = job;
    if (rollback) {
      const interrupted = createJobsStore(
        {
          ...f.sql,
          transaction: (work) =>
            f.sql.transaction!(async (tx) => {
              await work(tx);
              throw new Error("Connection lost before ACK deferral committed.");
            }),
        },
        btoa("\0".repeat(32)),
      );
      await expect(interrupted.retireStale(job, owner, "no_dispatch")).rejects.toThrow("Connection lost");
      expect(await store.inspect(job, owner)).toBe("stale");
      await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
      retireOwner = crypto.randomUUID();
      retireJob = (await store.claim("turn_dispatch", retireOwner, 30, 1))!;
      expect(await store.inspect(retireJob, retireOwner)).toBe("stale");
    }
    if (lateAck || hostJobOnly || resumeClaimOnly) await store.retireStale(retireJob, retireOwner, "no_dispatch");
    if (lateAck) {
      expect(
        (
          await db.query(
            `select state, attempts, generation::text, lease_owner, run_after > created_at as deferred
         from jobs where id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ state: "queued", attempts: rollback ? 1 : 0, generation: "2", lease_owner: null, deferred: true }]);
      await db.query("update docker_host_jobs set outcome='completed',completed_at=now() where request_id=$1", [
        resumeId,
      ]);
      await db.query("update jobs set run_after='-infinity' where id=$1", [id]);
      const successor = crypto.randomUUID();
      const resumed = await store.claim("turn_dispatch", successor, 30, 1);
      expect(resumed).toMatchObject({ id, generation: "3", payload: { requestId } });
      expect(await store.inspect(resumed!, successor)).toBe("dispatch");
    }
    expect(
      (
        await db.query(
          `select q.state, exists(select 1 from account_agent_reservations r
      where r.sandbox_id=q.sandbox_id and r.account_id=q.account_id) as reserved
     from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: failedWake ? "failed" : "dispatching", reserved: true }]);
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
