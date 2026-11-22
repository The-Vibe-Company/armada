import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  type Provider,
  ProviderError,
  type SandboxPatch,
  type SandboxRecord,
  type SandboxStore,
  type Sql,
} from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { extendSandbox } from "../src/sandbox-extend.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

const NOW = "2026-11-13T12:00:00.000Z";
beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => setSystemTime());
const database = rowOnlyDatabase();

function fixture() {
  const sandbox: SandboxRecord = {
    id: "logical",
    provider: "modal",
    providerSandboxId: "physical",
    goldenId: "golden",
    orgId: "org",
    ownerId: "owner",
    harness: "codex",
    status: "ready",
    conversationIds: ["retained"],
    createdAt: NOW,
    stoppedAt: null,
    deletedAt: null,
    statusReason: null,
    repositoryDir: null,
    model: "gpt-test",
    reasoningEffort: "high",
    expiresAt: "2026-11-13T12:05:00.000Z",
    lifecycleGeneration: 3,
  };
  const patches: SandboxPatch[] = [];
  const store = {
    update: async (_id: string, patch: SandboxPatch) => {
      patches.push(patch);
    },
  } as SandboxStore;
  return { sandbox, patches, store };
}

// The service policy is deterministic here; adapter wire behavior and full lifecycle belong to their owners/smoke.
test("extension confirms provider headroom before publishing the logical deadline and renewing leases", async () => {
  for (const status of ["ready", "running"] as const) {
    const f = fixture();
    f.sandbox.status = status;
    const calls: unknown[] = [];
    let renewals = 0;
    const provider = {
      id: "modal" as const,
      extendLifetime: async (input: unknown) => {
        calls.push(input);
        return new Date("2026-11-13T12:25:00.000Z");
      },
    } as Provider;
    const result = await extendSandbox(f.store, f.sandbox, provider, 1200, async () => {
      renewals++;
    });
    expect(calls).toEqual([{ sandboxId: "physical", ttlSeconds: 1500 }]);
    expect(result).toEqual({ id: "logical", expiresAt: "2026-11-13T12:20:00.000Z", ttlSeconds: 1200 });
    expect(f.patches.at(-1)).toMatchObject({
      expiresAt: "2026-11-13T12:20:00.000Z",
      effectiveTtlSeconds: 1200,
      finishActivity: true,
    });
    expect(renewals).toBe(1);
  }
});

test.each(["settled", "lease expired", "queue fault", "commit fault"] as const)(
  "unsafe extension settlement with %s",
  async (outcome) => {
    const { db, people, sharedGoldenId, openaiCredentialId } = await database();
    const { now } = (await db.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!;
    setSystemTime(now);
    const initial = new Date(now.getTime() + 300_000);
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,expires_at,reconcile_after)
       values($1,$2,$3,$4,'boat','physical','codex','running',$5,'infinity')`,
      [id, sharedGoldenId, people.org, people.owner, initial],
    );
    await db.query(
      `insert into account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,
         input_hash,input_enc,conversation_id,state)
       values($1,$2,$3,$4,$5,1,1,'hash','data','conversation','queued')`,
      [id, crypto.randomUUID(), openaiCredentialId, people.owner, people.org],
    );
    const realSql = bunLikeSql(db);
    const sql: Sql = {
      ...realSql,
      transaction: (work) =>
        realSql.transaction!(async (tx) => {
          const result = await work(tx);
          if (outcome === "commit fault") throw new Error("extension commit fault");
          return result;
        }),
    };
    const store = createSqlData(sql)({
      via: "service",
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" }],
    }).sandboxes;
    const sandbox = (await store.get(id))!;
    let renewed = false;
    const provider = {
      ...fakeBoat().provider,
      async extendLifetime() {
        if (outcome === "lease expired")
          await db.query("update sandboxes set activity_until=clock_timestamp() where id=$1", [id]);
        return new Date(now.getTime() + 240_000);
      },
    } satisfies Provider;
    if (outcome === "queue fault")
      await db.exec("alter table account_turn_queue add constraint extension_queue_fault check (state <> 'failed')");
    try {
      const result = extendSandbox(store, sandbox, provider, 1200, async () => {
        renewed = true;
      });
      if (outcome === "settled") await expect(result).rejects.toMatchObject({ code: "extension_state" });
      if (outcome === "lease expired") await expect(result).rejects.toMatchObject({ code: "sandbox_not_ready" });
      if (outcome === "queue fault") await expect(result).rejects.toThrow("extension_queue_fault");
      if (outcome === "commit fault") await expect(result).rejects.toThrow("extension commit fault");
    } finally {
      if (outcome === "queue fault")
        await db.exec("alter table account_turn_queue drop constraint extension_queue_fault");
    }
    expect(renewed).toBe(false);
    const settled = outcome === "settled";
    const {
      rows: [state],
    } = await db.query(
      `select status,status_reason,lifecycle_generation::int,stop_generation::int,expires_at,
         expires_at<=clock_timestamp() as expired,
         stop_requested_at is not null as stop_requested,activity_lease_id is not null as leased,
         activity_until is not null as lease_deadline,reconcile_after<=now() as scheduled,
         (select state from account_turn_queue where sandbox_id=s.id) as queued_turn
       from sandboxes s where id=$1`,
      [id],
    );
    expect(state).toMatchObject({
      status: settled ? "stopping" : "running",
      status_reason: settled ? "expired" : null,
      lifecycle_generation: sandbox.lifecycleGeneration! + (settled ? 2 : 1),
      stop_generation: settled ? 1 : 0,
      stop_requested: settled,
      leased: !settled,
      lease_deadline: !settled,
      scheduled: settled,
      expired: settled,
      queued_turn: settled ? "failed" : "queued",
      ...(settled ? {} : { expires_at: initial }),
    });
    expect(
      (
        await db.query(
          "select actor,code,from_status,to_status,generation::int from sandbox_transitions where sandbox_id=$1",
          [id],
        )
      ).rows,
    ).toEqual(
      settled
        ? [
            {
              actor: "expiry",
              code: "extension_expired",
              from_status: "running",
              to_status: "stopping",
              generation: sandbox.lifecycleGeneration! + 2,
            },
          ]
        : [],
    );
  },
);

test("a definite physical refusal preserves the old logical deadline and releases activity ownership", async () => {
  const f = fixture();
  const provider = {
    id: "modal" as const,
    extendLifetime: async (_input: unknown): Promise<Date> => {
      throw new ProviderError({
        provider: "modal",
        code: "invalid_request",
        message: "Physical cap",
        retryable: false,
      });
    },
  } as Provider;
  await expect(extendSandbox(f.store, f.sandbox, provider, 1200)).rejects.toMatchObject({ code: "extension_maximum" });
  expect(f.patches.at(-1)).toMatchObject({ finishActivity: true });
  expect(f.patches.some((patch) => patch.expiresAt !== undefined)).toBe(false);
});

test.each([{ boatRuntime: true, runtimeTransport: "dialout" }, { boatRuntime: true }] as const)(
  "enrolled Boat extension refuses before provider I/O (%j)",
  async (runtime) => {
    const f = fixture();
    const sandbox: SandboxRecord = { ...f.sandbox, ...runtime, provider: "boat" };
    const calls: string[] = [];
    const expiresAt = new Date("2026-11-13T12:25:00.000Z");
    const provider = {
      id: "boat",
      async get() {
        calls.push("read");
        return { state: "ready", providerState: "active", expiresAt };
      },
      async extendLifetime() {
        calls.push("extend");
        return expiresAt;
      },
    } as Provider;

    await expect(extendSandbox(f.store, sandbox, provider, 1_200)).rejects.toMatchObject({ code: "extension_state" });
    expect(calls).toEqual([]);
    expect(f.patches).toEqual([]);
  },
);

test("runtime Modal extension uses live headroom and an enrolled command grant without revoking the session", async () => {
  const { db, people } = await database();
  const { now } = (await db.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!;
  setSystemTime(now);
  const sql: import("@armada/core").Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const id = crypto.randomUUID();
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
         modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'extend','org','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!;
  const initial = new Date(now.getTime() + 300_000);
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,runtime_transport,expires_at)
     values($1,$2,$3,$4,'modal','physical','codex','ready','dialout',$5)`,
    [id, golden.id, people.org, people.owner, initial],
  );
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const store = createSqlData(sql)({
    via: "service",
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" }],
  }).sandboxes;
  const sandbox = (await store.get(id))!;
  const hard = new Date(now.getTime() + 1_800_000);
  const provider = {
    id: "modal",
    async get(target: string) {
      expect(target).toBe("physical");
      return { state: "ready", providerState: "active", expiresAt: hard };
    },
  } as Provider;
  const issue = (expiresAt?: number) =>
    authority.issue({
      sandboxId: id,
      ownerId: people.owner,
      configuration: { grant: { expiresAt: expiresAt ?? initial.getTime() } },
      ...(expiresAt === undefined ? {} : { commandGrantExpiresAt: expiresAt }),
    });
  const active = await authority.enrol((await issue(hard.getTime())).enrolmentToken);
  await db.query("update sandboxes set reconcile_lease_until='infinity' where id=$1", [id]);
  await expect(extendSandbox(store, sandbox, provider, 1_200)).rejects.toMatchObject({
    code: "sandbox_not_ready",
    cause: { reason: "runtime_reconciliation_active" },
  });
  expect((await store.get(id))!.expiresAt).toBe(initial.toISOString());
  await db.query("update sandboxes set reconcile_lease_until=null where id=$1", [id]);
  const extended = new Date(now.getTime() + 1_200_000).toISOString();
  expect(await extendSandbox(store, sandbox, provider, 1_200)).toEqual({ id, expiresAt: extended, ttlSeconds: 1_200 });
  await expect(extendSandbox(store, sandbox, provider, 1_600)).rejects.toMatchObject({ code: "extension_maximum" });
  await expect(extendSandbox(store, sandbox, provider, 1_100)).rejects.toMatchObject({ code: "sandbox_not_ready" });
  expect(await store.get(id)).toMatchObject({ expiresAt: extended, lifecycleGeneration: sandbox.lifecycleGeneration });
  expect(await authority.withSession(active.runtimeToken, active.epoch, async (_tx, scope) => scope.epoch)).toBe(
    active.epoch,
  );
  const previousServer = await issue();
  await db.query(
    "update runtime_enrolments set command_grant_epoch=$2,command_grant_expires_at=$3 where sandbox_id=$1",
    [id, active.epoch, hard],
  );
  const replacement = await authority.enrol(previousServer.enrolmentToken);
  expect(replacement.epoch).not.toBe(active.epoch);
  await expect(extendSandbox(store, sandbox, provider, 1_250)).rejects.toMatchObject({ code: "sandbox_not_ready" });
});
