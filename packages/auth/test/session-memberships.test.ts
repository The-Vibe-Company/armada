import { expect, test } from "bun:test";
import { createSqlAuthStore } from "../src/sql.ts";

test("session membership reads distinguish revoked sessions from live sessions with no orgs in one fresh query", async () => {
  let calls = 0;
  let rows: Record<string, unknown>[] = [{ org_id: "org_id", name: "Example", role: "member" }];
  const store = createSqlAuthStore({
    query: async <T extends Record<string, unknown>>(_sql: string, params?: readonly unknown[]) => {
      calls++;
      expect(params).toEqual(["session_id", "user_id", "2026-11-14T00:00:00Z"]);
      return { rows: rows as T[] };
    },
  });
  expect(await store.sessionMemberships!("user_id", "session_id", "2026-11-14T00:00:00Z")).toEqual([
    { orgId: "org_id", name: "Example", role: "member" },
  ]);
  rows = [{ org_id: null, name: null, role: null }];
  expect(await store.sessionMemberships!("user_id", "session_id", "2026-11-14T00:00:00Z")).toEqual([]);
  rows = [];
  expect(await store.sessionMemberships!("user_id", "session_id", "2026-11-14T00:00:00Z")).toBeNull();
  expect(calls).toBe(3);
});
