import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import { createOttoEngineApi } from "./engine-api.ts";

test("engine settings deny unauthenticated and cross-org access before reading accounts", async () => {
  const sql: Sql = {
    query: async () => {
      throw new Error("must not read");
    },
  };
  const reader = { credentials: async () => [], orgBoatKey: async () => null };
  const request = new Request("https://fixture.invalid/api/v1/otto/engine?org_id=other_org");
  const denied = createOttoEngineApi(sql, reader, undefined, async () => ({ ok: false }));
  expect((await denied(request))?.status).toBe(401);
  const scoped = createOttoEngineApi(sql, reader, undefined, async () => ({
    ok: true,
    caller: { userId: "user_one", orgs: [{ orgId: "org_one", role: "member" }], via: "supabase" },
  }));
  expect((await scoped(request))?.status).toBe(404);
});
