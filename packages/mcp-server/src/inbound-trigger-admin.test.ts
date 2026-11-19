import { afterAll, beforeAll, expect, test } from "bun:test";
import { createInboundTrigger } from "@armada/core/contract";
import { decryptSecret, type Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { AuthUnavailable, type CallerResult } from "./caller.ts";
import { inboundTriggerAdminRoute } from "./inbound-trigger-admin.ts";
import { createInboundTriggerStore } from "./inbound-trigger-store.ts";
import { observeRequest } from "./request-observability.ts";

const org = "750c538d-f473-4d84-b631-ea5fc12f0aaf";
const otherOrg = "fe826577-239f-49fa-a647-b61232cbedd0";
const id = "e8a9f7a2-747c-4a2f-936b-3f84238c4707";
const admin = { userId: id, via: "service", orgs: [{ orgId: org, role: "admin" }] } as const;

function request(path = "", orgId = org) {
  return new Request(`https://fixture.invalid/api/v1/triggers${path}?org=${orgId}`);
}

function fixture(rows: unknown[], auth: CallerResult = { ok: true, caller: admin }) {
  const queries: (unknown[] | undefined)[] = [];
  const sql: Sql = {
    async query<T>(_statement: string, params?: unknown[]) {
      queries.push(params);
      return { rows: rows as T[] };
    },
  };
  return { route: inboundTriggerAdminRoute(sql, async () => auth), queries };
}

test.each([
  ["unauthenticated", { ok: false }, org, 401],
  ["member", { ok: true, caller: { ...admin, orgs: [{ orgId: org, role: "member" }] } }, org, 403],
  ["token scoped to another org", { ok: true, caller: admin }, otherOrg, 403],
] as const)("rejects inspection by %s before querying triggers", async (_label, auth, orgId, status) => {
  const { route, queries } = fixture([], auth);
  expect((await route(request("", orgId)))?.status).toBe(status);
  expect(queries).toEqual([]);
});

test("reports authentication outages without exposing the dependency error", async () => {
  const route = inboundTriggerAdminRoute(
    {
      async query() {
        throw new Error("Unexpected database query");
      },
    },
    async () => {
      throw new AuthUnavailable("Internal dependency details");
    },
  );
  const response = await observeRequest(
    async () => (await route(request())) ?? undefined,
    () => {},
  );
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: { code: "dependency_unavailable", message: "Authentication is temporarily unavailable." },
  });
});

const db = new PGlite();
const templateOwner = "949426bc-9c76-49eb-beba-e8e271d012da";
const template = "124fb448-6103-47ee-8f51-80e080217237";
const sharedTemplate = "29578de5-ee88-4f11-b170-c4b28813aa7b";
const foreignTemplate = "e2debec7-563a-43f7-8f2c-04b8761b1ee5";
const host = "6eb8079a-05bd-4dd0-906e-63d81f750e9b";
const credential = "08d603df-dca1-44d1-b457-e36a328a3add";
const trigger = "bb995c90-964c-4140-83f7-f4dc3a5093d7";
const rollbackTrigger = "a1365cf6-b29d-478f-9f40-255a9462f682";
const rotationTrigger = "221401da-7f7e-42a6-87bc-f6a55047983d";
const disableTrigger = "3dfcb001-e5bb-4a9d-8c8a-dfa8427c6346";
const foreignTrigger = "21c61603-5156-4d2f-ad35-15bf65840f7d";
beforeAll(async () => {
  await db.exec(`
    create table public.launch_templates (id uuid, org_id uuid, scope text, owner_id uuid,
      current_revision int default 1, status text default 'active');
    create table public.launch_template_revisions (id uuid, template_id uuid, revision int, definition jsonb, digest text);
    create table public.docker_hosts (id uuid, org_id uuid, owner_id uuid, installation_id uuid, revoked_at timestamptz,
      hash text, registration_hash text);
    create table public.credentials (id uuid, version int, kind text, status text, expires_at timestamptz,
      scope text, owner_id uuid);
    create table public.agent_defaults (user_id uuid, harness text, credential_id uuid);
    create table public.triggers (id uuid default gen_random_uuid(), org_id uuid, template_id uuid, pool_harness text,
      enabled bool default true, rate_per_minute int, concurrency int, rate_refusals int default 0, secret_enc bytea,
      key_revision int default 1, launch_owner_id uuid);
    create table public.members (org_id uuid, user_id uuid, role text);
    create table public.trigger_admin_audit (org_id uuid, trigger_id uuid, actor_id uuid, action text,
      check (trigger_id <> '${rollbackTrigger}'), check (action in ('create', 'rotate', 'disable')));
    insert into public.members values ('${org}', '${id}', 'admin');
    create table public.jobs (id uuid, org_id uuid, kind text, state text, payload_enc bytea);
    create table public.trigger_deliveries (trigger_id uuid, delivery_id text, received_at timestamptz, job_id uuid);
    insert into public.launch_templates values
      ('${template}', '${org}', 'personal', '${templateOwner}'),
      ('${sharedTemplate}', '${org}', 'org', '${id}'),
      ('${foreignTemplate}', '${otherOrg}', 'org', null);
    insert into public.launch_template_revisions
      select gen_random_uuid(), id, 1,
        '{"provider":"docker","harness":"codex","hostId":"${host}","variables":[],"connections":[]}'::jsonb, 'digest'
      from public.launch_templates;
    insert into public.docker_hosts values ('${host}', '${org}', '${id}', gen_random_uuid(), null, 'opaque', null);
    insert into public.credentials values ('${credential}', 1, 'openai', 'active', null, 'org', '${org}');
    insert into public.agent_defaults values ('${id}', 'codex', '${credential}');
    insert into public.triggers values
      ('${trigger}', '${org}', '${template}', 'codex', true, 25, 2, 1, 'opaque', 1),
      ('${foreignTrigger}', '${otherOrg}', '${foreignTemplate}', 'codex', true, 2, 1, 0, 'opaque', 1);
    insert into public.jobs
      select md5(i::text)::uuid, '${org}', 'trigger', 'queued', 'opaque' from generate_series(1, 102) i;
    insert into public.trigger_deliveries
      select '${trigger}', 'event_' || i, '2026-11-19T00:00:00Z'::timestamptz + i * interval '1 second',
        md5(i::text)::uuid from generate_series(1, 102) i;
  `);
});

afterAll(async () => {
  await db.close();
});

const inspect = inboundTriggerAdminRoute(db, async () => ({ ok: true, caller: admin }));

test("lists only the organization's trigger metadata and redacts private template identifiers from other admins", async () => {
  const response = await inspect(request());
  const summary = {
    id: trigger,
    templateId: null,
    poolHarness: "codex",
    enabled: true,
    ratePerMinute: 25,
    concurrency: 2,
    rateRefusals: 1,
  };
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ triggers: [summary] });
  const inspectAsOwner = inboundTriggerAdminRoute(db, async () => ({
    ok: true,
    caller: { ...admin, userId: templateOwner },
  }));
  expect(await (await inspectAsOwner(request()))?.json()).toEqual({ triggers: [{ ...summary, templateId: template }] });
});

test("lists the latest 100 admitted deliveries without queued payloads", async () => {
  const response = await inspect(request(`/${trigger}/deliveries`));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    deliveries: Array.from({ length: 100 }, (_, index) => ({
      deliveryId: `event_${102 - index}`,
      receivedAt: new Date(Date.UTC(2026, 10, 19, 0, 0, 102 - index)).toISOString().replace(".000Z", "+00:00"),
      jobState: "queued",
    })),
  });
});

test("returns 404 for a trigger in a different organization", async () => {
  expect((await inspect(request(`/${foreignTrigger}/deliveries`)))?.status).toBe(404);
});

const encryptionKey = Buffer.alloc(32, 42).toString("base64");
const manage = inboundTriggerAdminRoute(db, async () => ({ ok: true, caller: admin }), encryptionKey);

const now = Date.UTC(2026, 10, 19);
const ingress = createInboundTriggerStore(
  db,
  {
    async enqueue() {
      throw new Error("An invalidated delivery reached enqueue");
    },
  },
  encryptionKey,
  () => now,
);

async function staleAdmission(triggerId: string) {
  return ingress.admit({
    triggerId,
    revision: 7,
    timestamp: now / 1000,
    deliveryId: "stale",
    body: "",
  });
}

function post(triggerId: string, action: string) {
  return new Request(request(`/${triggerId}/${action}`), { method: "POST" });
}

async function addManagedTrigger(triggerId: string) {
  await db.query("insert into public.triggers values ($1, $2, $3, 'codex', true, 25, 2, 0, 'opaque', 7)", [
    triggerId,
    org,
    template,
  ]);
}

test("rotation advances ingress key revision and returns the new key only in its non-cacheable response", async () => {
  await addManagedTrigger(rotationTrigger);
  const response = await manage(post(rotationTrigger, "rotate"));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  const payload = (await response?.json()) as { signingSecret: string };
  expect(Object.keys(payload)).toEqual(["signingSecret"]);
  const { signingSecret } = payload;
  expect(Buffer.from(signingSecret, "base64")).toHaveLength(32);
  const { rows } = await db.query<{ key_revision: number; ciphertext: string }>(
    "select key_revision, encode(secret_enc, 'hex') as ciphertext from public.triggers where id = $1",
    [rotationTrigger],
  );
  expect(rows[0]?.key_revision).toBe(8);
  expect(await staleAdmission(rotationTrigger)).toEqual({ status: "unauthorized" });
  const sealed = Uint8Array.from(Buffer.from(rows[0]!.ciphertext, "hex"));
  expect((await decryptSecret(sealed, encryptionKey)) === signingSecret).toBe(true);
  const inspection = (await (await manage(request()))?.json()) as { triggers: { id: string }[] };
  const summary = inspection.triggers.find((entry) => entry.id === rotationTrigger);
  expect(Object.keys(summary ?? {}).sort()).toEqual([
    "concurrency",
    "enabled",
    "id",
    "poolHarness",
    "ratePerMinute",
    "rateRefusals",
    "templateId",
  ]);
  expect(
    (
      await db.query("select org_id, actor_id, action from public.trigger_admin_audit where trigger_id = $1", [
        rotationTrigger,
      ])
    ).rows,
  ).toEqual([{ org_id: org, actor_id: id, action: "rotate" }]);
});

test("disable stops admission and writes one audit event across repeated calls", async () => {
  await addManagedTrigger(disableTrigger);
  expect((await manage(post(disableTrigger, "disable")))?.status).toBe(204);
  expect((await manage(post(disableTrigger, "disable")))?.status).toBe(204);
  expect(await staleAdmission(disableTrigger)).toEqual({ status: "unauthorized" });
  expect((await manage(post(disableTrigger, "rotate")))?.status).toBe(404);
  expect(
    (await db.query("select enabled, key_revision from public.triggers where id = $1", [disableTrigger])).rows,
  ).toEqual([{ enabled: false, key_revision: 7 }]);
  expect(
    (await db.query("select action from public.trigger_admin_audit where trigger_id = $1", [disableTrigger])).rows,
  ).toEqual([{ action: "disable" }]);
});

test("rotation cannot target a trigger in another organization", async () => {
  expect((await manage(post(foreignTrigger, "rotate")))?.status).toBe(404);
});

test("a stale admin claim cannot mutate a trigger after membership revocation", async () => {
  const stale = inboundTriggerAdminRoute(db, async () => ({
    ok: true,
    caller: { ...admin, userId: templateOwner },
  }));
  expect((await stale(post(trigger, "disable")))?.status).toBe(404);
  expect((await db.query("select enabled from public.triggers where id = $1", [trigger])).rows).toEqual([
    { enabled: true },
  ]);
});

test("an audit write failure rolls back the trigger change", async () => {
  await addManagedTrigger(rollbackTrigger);
  await expect(manage(post(rollbackTrigger, "disable"))).rejects.toMatchObject({ code: "23514" });
  expect((await db.query("select enabled from public.triggers where id = $1", [rollbackTrigger])).rows).toEqual([
    { enabled: true },
  ]);
});

const configuration = { templateId: sharedTemplate, poolHarness: "codex", ratePerMinute: 10, concurrency: 2 };

function createRequest(overrides: Record<string, unknown> = {}) {
  return new Request(request(), { method: "POST", body: JSON.stringify({ ...configuration, ...overrides }) });
}

test("creates an audited trigger and discloses the signing key once", async () => {
  const response = await manage(createRequest());
  expect(response?.status).toBe(201);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  const { triggerId, signingSecret } = createInboundTrigger.output.parse(await response?.json());
  const key = await ingress.signingKey(triggerId);
  expect(key?.revision).toBe(1);
  expect(key?.key.byteLength).toBe(32);
  expect(Buffer.from(key!.key).toString("base64") === signingSecret).toBe(true);
  expect(
    (
      await db.query(
        `select t.launch_owner_id, a.actor_id, a.action from public.triggers t
         join public.trigger_admin_audit a on a.trigger_id = t.id and a.org_id = t.org_id where t.id = $1`,
        [triggerId],
      )
    ).rows,
  ).toEqual([{ launch_owner_id: id, actor_id: id, action: "create" }]);
  const list = (await (await manage(request()))?.json()) as { triggers: Record<string, unknown>[] };
  expect(list.triggers.find((entry) => entry.id === triggerId)).toEqual({
    ...configuration,
    id: triggerId,
    enabled: true,
    rateRefusals: 0,
  });
});

test.each([
  ["another admin's private template", { templateId: template }, 409],
  ["a template in another organization", { templateId: foreignTemplate }, 409],
  ["a pool for a different harness", { poolHarness: "claude" }, 409],
  ["a limit outside the database range", { concurrency: 2_147_483_648 }, 400],
  ["an extra credential selector", { credentialId: credential }, 400],
] as const)("rejects trigger creation with %s", async (_label, overrides, status) => {
  expect((await manage(createRequest(overrides)))?.status).toBe(status);
});

test("refuses trigger creation after its bound Docker host is revoked", async () => {
  await db.query("update public.docker_hosts set revoked_at = now() where id = $1", [host]);
  try {
    expect((await manage(createRequest()))?.status).toBe(409);
  } finally {
    await db.query("update public.docker_hosts set revoked_at = null where id = $1", [host]);
  }
});

test("refuses trigger creation with an account outside the organization's pool", async () => {
  await db.query("update public.credentials set owner_id = $1 where id = $2", [otherOrg, credential]);
  try {
    expect((await manage(createRequest()))?.status).toBe(409);
  } finally {
    await db.query("update public.credentials set owner_id = $1 where id = $2", [org, credential]);
  }
});

test("a stale admin claim cannot create a trigger after membership revocation", async () => {
  const stale = inboundTriggerAdminRoute(
    db,
    async () => ({
      ok: true,
      caller: { ...admin, userId: templateOwner },
    }),
    encryptionKey,
  );
  expect((await stale(createRequest()))?.status).toBe(403);
});

test("a failed creation audit leaves no new trigger", async () => {
  const count = () => db.query("select count(*)::int as count from public.triggers");
  const before = await count();
  await db.exec(
    "alter table public.trigger_admin_audit add constraint block_creation check (action <> 'create') not valid",
  );
  try {
    await expect(manage(createRequest())).rejects.toMatchObject({ code: "23514" });
    expect(await count()).toEqual(before);
  } finally {
    await db.exec("alter table public.trigger_admin_audit drop constraint block_creation");
  }
});

test("returns a retryable refusal when issuer membership is locked", async () => {
  const sql: Sql = {
    query: db.query.bind(db),
    async transaction() {
      throw Object.assign(new Error("Issuer membership is locked"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "55P03",
      });
    },
  };
  const route = inboundTriggerAdminRoute(sql, async () => ({ ok: true, caller: admin }), encryptionKey);
  const response = await route(createRequest());
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: {
      code: "dependency_unavailable",
      message: "The template's Docker host membership is being updated. Try again.",
    },
  });
});
