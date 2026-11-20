import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabaseReadiness } from "../../packages/mcp-server/src/database-readiness.ts";
import { closeableFixture } from "../../packages/mcp-server/test/closeable.fixture.ts";
import { openMigratedDatabase } from "./migrated-database.ts";

const firstFixture = closeableFixture(openMigratedDatabase);
const secondFixture = closeableFixture(openMigratedDatabase);
beforeAll(async () => {
  await Promise.all([firstFixture.setup(), secondFixture.setup()]);
});
afterAll(async () => {
  try {
    await firstFixture.close();
  } finally {
    await secondFixture.close();
  }
});

test("migrated fixtures isolate data, schema, roles and connection lifetime", async () => {
  await firstFixture
    .get()
    .exec("insert into orgs(name) values('first fixture'); create table fixture_only(id int); set role authenticated");
  const second = secondFixture.get();
  expect((await second.query<{ count: number }>("select count(*)::int as count from orgs")).rows[0]?.count).toBe(0);
  expect(
    (await second.query<{ name: string | null }>("select to_regclass('public.fixture_only')::text as name")).rows[0]
      ?.name,
  ).toBeNull();
  expect((await second.query<{ role: string }>("select current_user as role")).rows[0]?.role).toBe("postgres");
  await firstFixture.close();
  expect(
    (await second.query<{ count: number }>("select count(*)::int as count from supabase_migrations.schema_migrations"))
      .rows[0]?.count,
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
});
