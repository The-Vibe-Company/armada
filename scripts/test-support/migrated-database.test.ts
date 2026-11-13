import { expect, test } from "bun:test";
import { createDatabaseReadiness } from "../../packages/mcp-server/src/database-readiness.ts";
import { openMigratedDatabase } from "./migrated-database.ts";

test("migrated fixtures isolate data, schema, roles and connection lifetime", async () => {
  const first = await openMigratedDatabase();
  const second = await openMigratedDatabase();
  try {
    await first.exec(
      "insert into orgs(name) values('first fixture'); create table fixture_only(id int); set role authenticated",
    );
    expect((await second.query<{ count: number }>("select count(*)::int as count from orgs")).rows[0]?.count).toBe(0);
    expect(
      (await second.query<{ name: string | null }>("select to_regclass('public.fixture_only')::text as name")).rows[0]
        ?.name,
    ).toBeNull();
    expect((await second.query<{ role: string }>("select current_user as role")).rows[0]?.role).toBe("postgres");
    await first.close();
    expect(
      (
        await second.query<{ count: number }>(
          "select count(*)::int as count from supabase_migrations.schema_migrations",
        )
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
    // The immutable template must also survive a mutated sibling closing before the next clone.
    const later = await openMigratedDatabase();
    try {
      expect((await later.query("select name from orgs")).rows).toEqual([]);
      expect((await later.query("select to_regclass('public.fixture_only') as relation")).rows).toEqual([
        { relation: null },
      ]);
      expect((await later.query("select current_user as role")).rows).toEqual([{ role: "postgres" }]);
      expect(await createDatabaseReadiness(later)()).toBe(true);
    } finally {
      await later.close();
    }
  } finally {
    if (!first.closed) await first.close();
    await second.close();
  }
});
