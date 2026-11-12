import { expect, test } from "bun:test";
import { createDatabaseReadiness } from "../src/database-readiness.ts";
import { migratedDatabase } from "./migrated-database.ts";

test("migrated fixtures isolate rows, schema, roles and lifecycle from peers and later restores", async () => {
  const [first, peer] = await Promise.all([migratedDatabase(), migratedDatabase()]);
  try {
    await first.exec(`
      insert into orgs (name) values ('fixture-only');
      create table public.fixture_only (id integer);
      set role authenticated;
    `);
    expect((await first.query("select current_user as role")).rows).toEqual([{ role: "authenticated" }]);
    for (const db of [peer]) {
      expect((await db.query("select name from orgs")).rows).toEqual([]);
      expect((await db.query("select to_regclass('public.fixture_only') as relation")).rows).toEqual([
        { relation: null },
      ]);
      expect((await db.query("select current_user as role")).rows).toEqual([{ role: "postgres" }]);
      expect(await createDatabaseReadiness(db)()).toBe(true);
    }
  } finally {
    await first.close();
    await peer.close();
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
