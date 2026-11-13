import { expect, test } from "bun:test";
import { createDatabaseReadiness } from "../src/database-readiness.ts";
import { migratedDatabase } from "./migrated-database.ts";

test("later migrated fixtures remain pristine after a mutated fixture closes", async () => {
  const first = await migratedDatabase();
  try {
    await first.exec(`
      insert into orgs (name) values ('fixture-only');
      create table public.fixture_only (id integer);
      set role authenticated;
    `);
  } finally {
    await first.close();
  }
  const later = await migratedDatabase();
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
