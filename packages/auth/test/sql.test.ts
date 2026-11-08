import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlAuthStore, type SqlQuery } from "../src/sql.ts";
import { ORG_ID, proveAuth, STRANGER_ID, USER_ID } from "./prove.ts";

describe("sql store", () => {
  test("tokens land as hashes and a revoked one is refused", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      await db.query("insert into auth.users (id) values ($1), ($2)", [USER_ID, STRANGER_ID]);
      await db.query("insert into orgs (id, name) values ($1, 'Example')", [ORG_ID]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [ORG_ID, USER_ID]);
      const clock = { at: new Date("2026-11-08T00:00:00.000Z") };
      await proveAuth({
        store: createSqlAuthStore(serviceQuery(db)),
        now: () => clock.at,
        advance: (ms) => {
          clock.at = new Date(clock.at.getTime() + ms);
        },
        snapshot: () => snapshot(db),
      });

      await expect(
        asUser(db, USER_ID, () =>
          db.query("insert into mcp_tokens (user_id, org_id, hash, label) values ($1, $2, $3, 'access')", [
            USER_ID,
            ORG_ID,
            "ab".repeat(32),
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });

  test("a redirect that is not loopback http, https, or a native scheme is rejected", async () => {
    const db = await openDatabase();
    try {
      await applyMigrations(db);
      const store = createSqlAuthStore(serviceQuery(db));
      await expect(
        store.insertClient({ id: "ab".repeat(16), name: "Nope", redirectUris: ["http://evil.example/callback"] }),
      ).rejects.toThrow();
      await store.insertClient({
        id: "cd".repeat(16),
        name: "Cursor",
        redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      });
    } finally {
      await db.close();
    }
  });
});

function serviceQuery(db: PGlite): SqlQuery {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      await db.exec("begin");
      try {
        await db.exec("set local role service_role");
        const result = await db.query<T>(sql, params as never[]);
        await db.exec("commit");
        return { rows: result.rows };
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    },
  };
}

async function asUser<T>(db: PGlite, userId: string, run: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await db.exec("set local role authenticated");
    const value = await run();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function snapshot(db: PGlite): Promise<string> {
  const result = await db.query<{ blob: string }>(`
    select coalesce(string_agg(value, ','), '') as blob from (
      select hash as value from service_tokens
      union all select label from service_tokens
      union all select hash from mcp_tokens
      union all select label from mcp_tokens
      union all select hash from oauth_codes
      union all select code_challenge from oauth_codes
    ) rows
  `);
  return result.rows[0]?.blob ?? "";
}
