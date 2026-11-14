import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { createOttoObjectivesApi } from "./objectives-api.ts";

const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
test("objective API denies unauthenticated and cross-organization access before storage", async () => {
  const sql: Sql = {
    query: async () => {
      throw Error("storage must not be accessed");
    },
  };
  for (const auth of [
    { ok: false } as const,
    { ok: true, caller: { userId: user, orgs: [], via: "supabase" } } as const,
  ]) {
    const route = createOttoObjectivesApi(sql, async () => auth);
    const response = await route(new Request(`https://armada.test/api/v1/otto/objectives?org_id=${org}`));
    expect(response?.status).toBe(auth.ok ? 404 : 401);
  }
});
test("objective creation rejects disconnected repositories and malformed requests", async () => {
  const sql: Sql = { query: async () => ({ rows: [] }) };
  const route = createOttoObjectivesApi(sql, async () => ({
    ok: true,
    caller: { userId: user, orgs: [{ orgId: org, role: "member" }], via: "supabase" },
  }));
  for (const body of [{ repository: "owner/repository", request: "Do this" }, { request: " " }, null]) {
    const response = await route(
      new Request(`https://armada.test/api/v1/otto/objectives?org_id=${org}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response?.status).toBe(400);
  }
});

test("service and MCP callers cannot read or write private objective threads", async () => {
  const sql: Sql = {
    query: async () => {
      throw Error("must deny before storage");
    },
  };
  for (const via of ["service", "mcp"] as const) {
    const route = createOttoObjectivesApi(sql, async () => ({
      ok: true,
      caller: {
        userId: user,
        orgs: [{ orgId: org, role: "member" }],
        via,
      },
    }));
    for (const suffix of ["", `/${user}`]) {
      for (const method of ["GET", "POST"]) {
        const response = await route(
          new Request(`https://armada.test/api/v1/otto/objectives${suffix}?org_id=${org}`, { method }),
        );
        expect(response?.status).toBe(403);
      }
    }
  }
});
