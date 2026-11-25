import { afterAll, beforeAll, expect, test } from "bun:test";
import { DelegatedAuthority, type Sql } from "@armada/core/server";
import { insertSandboxFixture } from "../../core/test/sandbox.fixture.ts";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { createSandboxArmadaAccess } from "../src/sandbox-armada-access.ts";
import { enqueueModalStop } from "../src/sandbox-lifecycle.ts";
import { runClaimedStop } from "./stop-job.fixture.ts";
import { database, ENCRYPTION_KEY, fakeBoat, PUBLIC_URL } from "./support.ts";

let prepared: Promise<Awaited<ReturnType<typeof database>>> | undefined;
beforeAll(async () => {
  prepared = database();
  await prepared;
});
afterAll(async () => {
  const pending = prepared;
  prepared = undefined;
  await pending?.then(
    ({ db }) => db.close(),
    () => undefined,
  );
});

// SQL is the owner of immutable routing and stopped archive authority.
// This protects Modal admission (previously Boat/Docker only), not provider inference.
test("Modal OpenCode dial-out persists routing and retains enrolled authority through launch but not stop", async () => {
  const fixture = await prepared;
  if (!fixture) throw Error("Modal runtime database is not open");
  const { db, people } = fixture;
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
    values($1,$2,'dialout-modal','private','modal','master','image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!;
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const store = createSqlData(sql)(caller).sandboxes;
  const row = await insertSandboxFixture(sql, {
    id: crypto.randomUUID(),
    provider: "modal",
    modalTransport: "dialout",
    providerSandboxId: "modal-machine",
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "opencode",
    status: "starting",
    activityLeaseId: crypto.randomUUID(),
    model: "opencode/fixture",
    reasoningEffort: "default",
  });
  expect((await store.get(row.id))?.modalTransport).toBe("dialout");
  expect((await sql.query("select runtime_transport from sandboxes where id=$1", [row.id])).rows).toEqual([
    { runtime_transport: "dialout" },
  ]);
  await expect(db.query("update sandboxes set runtime_transport=null where id=$1", [row.id])).rejects.toThrow(
    "transport is immutable",
  );
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const active = await authority.enrol(
    (await authority.issue({ sandboxId: row.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
  );
  await db.query(
    "update sandboxes set status='running',activity_lease_id=null,activity_until=null,task_prompt_id='p' where id=$1",
    [row.id],
  );
  await authority.withSession(active.runtimeToken, active.epoch, async () => true);
  const events = createRuntimeEvents(authority, ENCRYPTION_KEY);
  await events.append(active.runtimeToken, active.epoch, {
    sandboxId: row.id,
    generation: active.epoch,
    events: [
      {
        sequence: 1,
        event: { id: "answer", at: 1, kind: "message", promptId: "p", text: "MODAL_OK", partial: false, tools: [] },
      },
      {
        sequence: 2,
        event: { id: "finish", at: 2, kind: "prompt", promptId: "p", status: "finished", text: "reply" },
      },
    ],
  });
  await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [row.id]);
  await expect(authority.withSession(active.runtimeToken, active.epoch, async () => true)).rejects.toThrow();
  const host = { ...fakeBoat().provider, id: "modal" as const };
  const provider = await createRuntimeServing(sql, ENCRYPTION_KEY)(
    host,
    {
      id: row.id,
      modalTransport: "dialout",
      provider: "modal",
      orgId: people.org,
      visibility: "private",
      modal: { workspace: "workspace", environment: "main", appId: "app" },
    },
    { userId: people.owner },
  );
  expect(await provider.events({ sandboxId: "modal-machine" })).toMatchObject({
    source: "armada-runtime",
    events: [{ text: "MODAL_OK" }, { status: "finished" }],
  });
});

test("enrolled Modal scoped parent cleanup requires a lifecycle fence and reaches compute without a native runner", async () => {
  const fixture = await prepared;
  if (!fixture) throw Error("Modal runtime database is not open");
  const { db, people } = fixture;
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const golden = (
    await db.query<{ id: string }>(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'scoped-cleanup','private','modal','scoped-master','scoped-image','workspace','main','app','{"repos":[],"init":[]}') returning id`,
      [people.org, people.owner],
    )
  ).rows[0]!;
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const fake = fakeBoat();
  const machine = await fake.provider.fork({ from: "test", name: "parent", ttlSeconds: 3600, env: {}, noEnv: true });
  const row = await insertSandboxFixture(sql, {
    id: crypto.randomUUID(),
    provider: "modal",
    modalTransport: "dialout",
    providerSandboxId: machine.id,
    goldenId: golden.id,
    orgId: people.org,
    ownerId: people.owner,
    harness: "codex",
    status: "ready",
    model: "m",
    reasoningEffort: "high",
    visibility: "private",
  });
  await sql.query(
    `insert into armada_access_parents(id,kind,org_id,owner_id,sandbox_id,state)
     values($1,'sandbox',$2,$3,$1,'ready')`,
    [row.id, people.org, people.owner],
  );
  await sql.query("update sandboxes set lifecycle_generation=1 where id=$1", [row.id]);
  const generation = (
    await sql.query<{ generation: string }>(
      "select lifecycle_generation::text as generation from sandboxes where id=$1",
      [row.id],
    )
  ).rows[0]!.generation;
  const authority = new DelegatedAuthority(sql, async () => {});
  let token = "";
  let issuedEpoch = "";
  await authority.installEpoch(
    row.id,
    {
      physicalGeneration: "1",
      lifecycleGeneration: generation,
      async deliver(value, binding) {
        token = value;
        issuedEpoch = binding.epoch;
        return { acknowledged: true };
      },
      async scrub() {},
    },
    { scopes: ["worker:stop"], goldenIds: [], credentialIds: [] },
  );
  const admit = () => authority.admit(token, { method: "finish" }, async () => true);
  expect(await admit()).toBe(true);

  const access = createSandboxArmadaAccess({ sql, encryptionKey: ENCRYPTION_KEY, publicUrl: PUBLIC_URL });
  const host = {
    ...fake.provider,
    id: "modal" as const,
    async get(id: string) {
      return { ...(await fake.provider.get(id)), providerState: "active", physicalGeneration: "1" };
    },
    async runtimeStopMachine() {
      return {
        physical: { machineId: machine.id, generation: 1 },
        stopped: false,
        machine: {
          async stop({ retain }: { retain: boolean }) {
            expect(retain).toBe(false);
            await fake.provider.stop({ sandboxId: machine.id });
            return null;
          },
        },
      };
    },
  };
  const provider = await createRuntimeServing(sql, ENCRYPTION_KEY)(
    access.wrap(host),
    { ...row, visibility: "private", modal: { workspace: "workspace", environment: "main", appId: "app" } },
    { userId: people.owner },
    async () => ({ status: "clean" }),
  );
  const request = { sandboxId: machine.id };
  await expect(provider.delete(request)).rejects.toThrow("requires a lifecycle stop or terminal state");
  expect(await admit()).toBe(true);

  await sql.transaction!(async (tx) => {
    await tx.query("update sandboxes set status='stopping',stop_requested_at=now() where id=$1", [row.id]);
    expect(await enqueueModalStop(tx, row.id, generation)).toBe(true);
  });
  const parent = await sql.query<{ epoch: string }>(
    "select authority_epoch::text as epoch from armada_access_parents where id=$1",
    [row.id],
  );
  expect(BigInt(parent.rows[0]!.epoch)).toBeGreaterThan(BigInt(issuedEpoch));
  await expect(admit()).rejects.toThrow("denied");
  await expect(provider.delete(request)).rejects.toThrow("requires a lifecycle stop or terminal state");
  expect((await runClaimedStop(sql, async () => provider)).result.status).toBe("done");
  expect((await fake.provider.get(machine.id)).state).toBe("stopped");
  expect((await createSqlData(sql)(caller).sandboxes.get(row.id))?.status).toBe("stopped");
  await expect(provider.delete(request)).resolves.toMatchObject({ status: "pending" });
});
