import { expect, test } from "bun:test";
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
  } finally {
    if (!first.closed) await first.close();
    await second.close();
  }
});
