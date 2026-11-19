import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { AuthUnavailable, type CallerResult } from "./caller.ts";
import { inboundTriggerAdminRoute } from "./inbound-trigger-admin.ts";
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
const foreignTemplate = "e2debec7-563a-43f7-8f2c-04b8761b1ee5";
const trigger = "bb995c90-964c-4140-83f7-f4dc3a5093d7";
const foreignTrigger = "21c61603-5156-4d2f-ad35-15bf65840f7d";
beforeAll(async () => {
  await db.exec(`
    create table public.launch_templates (id uuid, org_id uuid, scope text, owner_id uuid);
    create table public.triggers (id uuid, org_id uuid, template_id uuid, pool_harness text,
      enabled bool, rate_per_minute int, concurrency int, rate_refusals int, secret_enc bytea);
    create table public.jobs (id uuid, org_id uuid, kind text, state text, payload_enc bytea);
    create table public.trigger_deliveries (trigger_id uuid, delivery_id text, received_at timestamptz, job_id uuid);
    insert into public.launch_templates values
      ('${template}', '${org}', 'personal', '${templateOwner}'),
      ('${foreignTemplate}', '${otherOrg}', 'org', null);
    insert into public.triggers values
      ('${trigger}', '${org}', '${template}', 'codex', true, 25, 2, 1, 'opaque'),
      ('${foreignTrigger}', '${otherOrg}', '${foreignTemplate}', 'codex', true, 2, 1, 0, 'opaque');
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
