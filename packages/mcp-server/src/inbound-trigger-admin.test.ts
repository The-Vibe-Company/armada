import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import { inboundTriggerAdminRoute } from "./inbound-trigger-admin.ts";

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

test("lists trigger configuration without returning stored signing material", async () => {
  const trigger = {
    id,
    templateId: null,
    poolHarness: "codex",
    enabled: false,
    ratePerMinute: 3,
    concurrency: 1,
    rateRefusals: 5,
  };
  const { route } = fixture([{ ...trigger, secret_enc: "encrypted" }]);
  const response = await route(request());
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ triggers: [trigger] });
});

test("inspect returns admitted deliveries with processing state and excludes queued payloads", async () => {
  const delivery = { deliveryId: "event_1", receivedAt: "2026-11-19T03:00:00Z", jobState: "queued" };
  const { route } = fixture([{ deliveries: [{ ...delivery, payload_enc: "encrypted" }] }]);
  const response = await route(request(`/${id}/deliveries`));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ deliveries: [delivery] });
});

test("returns 404 instead of an empty history for an inaccessible trigger", async () => {
  const { route, queries } = fixture([]);
  expect((await route(request(`/${id}/deliveries`)))?.status).toBe(404);
  expect(queries).toEqual([[id, org]]);
});
