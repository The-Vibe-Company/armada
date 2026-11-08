import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";

test("golden backend slots are service-role only", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const grants = await db.query<{ grantee: string }>(
      "select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'golden_backend_slots' and grantee in ('anon', 'authenticated', 'PUBLIC')",
    );
    expect(grants.rows).toEqual([]);
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'golden_backend_slots'",
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
  } finally {
    await db.close();
  }
});
