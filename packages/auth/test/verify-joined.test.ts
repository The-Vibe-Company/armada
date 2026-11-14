import { expect, test } from "bun:test";
import { createSqlAuthStore } from "../src/sql.ts";
import { authenticate } from "../src/verify.ts";

test("SQL bearer verification uses one fresh read and refuses changed authorization", async () => {
  const now = new Date("2026-11-14T00:00:00Z");
  let queries = 0;
  let rows: Record<string, unknown>[] = [];
  const store = createSqlAuthStore({
    async query<T extends Record<string, unknown>>() {
      queries++;
      return { rows: rows as T[] };
    },
  });
  const row = {
    id: "token_id",
    user_id: "user_id",
    org_id: "org_id",
    label: "access",
    revoked_at: null,
    created_at: now.toISOString(),
    role: "admin",
    name: "Example",
  };
  // Construct token-shaped bytes only at runtime.
  const bearer = `Bearer ${["armada", "sk", "a".repeat(43)].join("_")}`;
  rows = [row];
  expect((await authenticate(bearer, store, now)).ok).toBe(true);
  expect(queries).toBe(1);
  rows = [{ ...row, revoked_at: now.toISOString() }];
  expect((await authenticate(bearer, store, now)).ok).toBe(false);
  rows = []; // Membership removed: the inner join no longer returns the token.
  expect((await authenticate(bearer, store, now)).ok).toBe(false);
  expect(queries).toBe(3);
});
