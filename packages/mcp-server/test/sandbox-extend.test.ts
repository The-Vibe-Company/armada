import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { type Provider, ProviderError, type SandboxPatch, type SandboxRecord, type SandboxStore } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { extendSandbox } from "../src/sandbox-extend.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

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

test("a physical cap below the retained deadline schedules stop and releases the preservation-blocking lease", async () => {
  const f = fixture();
  let renewed = false;
  const provider = {
    id: "modal",
    extendLifetime: async (_input: unknown) => new Date("2026-11-13T12:04:00.000Z"),
  } as Provider;
  await expect(
    extendSandbox(f.store, f.sandbox, provider, 1200, async () => {
      renewed = true;
    }),
  ).rejects.toMatchObject({ code: "extension_state" });
  expect(f.patches.at(-1)).toMatchObject({
    status: "stopping",
    statusReason: "expired",
    expiresAt: NOW,
    stopRequested: true,
    finishActivity: true,
  });
  expect(renewed).toBe(false);
});

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
