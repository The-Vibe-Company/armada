import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabaseReadiness } from "../../packages/mcp-server/src/database-readiness.ts";
import { openMigratedDatabase } from "./migrated-database.ts";

let firstFixture: Awaited<ReturnType<typeof openMigratedDatabase>> | undefined;
let secondFixture: Awaited<ReturnType<typeof openMigratedDatabase>> | undefined;
beforeAll(async () => {
  firstFixture = await openMigratedDatabase();
  secondFixture = await openMigratedDatabase();
});
afterAll(async () => {
  const first = firstFixture;
  const second = secondFixture;
  firstFixture = undefined;
  secondFixture = undefined;
  if (first && !first.closed) await first.close();
  await second?.close();
});

test("migrated fixtures isolate data, schema, roles and connection lifetime", async () => {
  const first = firstFixture;
  const second = secondFixture;
  if (!first || !second) throw new Error("Missing migrated sibling fixtures");
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
