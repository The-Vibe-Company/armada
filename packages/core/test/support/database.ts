import { afterAll, beforeAll, beforeEach } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase, resetMigratedDatabaseRows } from "../../../../scripts/test-support/migrated-database.ts";

/**
 * One real migrated database per serial test file, with empty application rows
 * before each case. Schema bytes are shared, never live connections between files.
 * Temporary schema changes must be restored by their case; migration tests
 * need their own database. Session identity is reset between cases. Native transactions stay real.
 */
export function migratedDatabase(): () => PGlite {
  let db: PGlite | undefined;
  let reset: string;
  beforeAll(async () => {
    db = await openMigratedDatabase();
    const tables = await db.query<{ name: string }>(
      `select format('%I.%I', schemaname, tablename) as name
       from pg_tables where schemaname in ('public', 'auth')`,
    );
    const sequences = await db.query<{ name: string }>(`
      select distinct format('%I.%I', sn.nspname, s.relname) as name
      from pg_class s
      join pg_namespace sn on sn.oid=s.relnamespace
      join pg_depend d on d.classid='pg_class'::regclass and d.objid=s.oid
        and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
      join pg_class t on t.oid=d.refobjid
      join pg_namespace tn on tn.oid=t.relnamespace
      where s.relkind='S' and tn.nspname in ('public','auth')
    `);
    // Repeated TRUNCATE recreates every relation and grows PGlite's catalog/VFS.
    // Cleanup is transactional: bypass row/FK triggers only here, never in test actions.
    const statements = [
      "set local session_replication_role=replica",
      ...tables.rows.map((row) => `delete from ${row.name}`),
      ...sequences.rows.map((row) => `alter sequence ${row.name} restart`),
    ];
    // One server-side block avoids returning an unused command result per table.
    reset = (
      await db.query<{ command: string }>("select format('do %L', $1::text) as command", [
        `begin\n${statements.join(";\n")};\nend;`,
      ])
    ).rows[0]!.command;
  });
  beforeEach(async () => {
    await db!.exec("reset role; reset all; set search_path=public");
    await resetMigratedDatabaseRows(db!, reset);
  });
  afterAll(async () => {
    // Bun retains hook closures; release the closed instance and its WASM heap.
    const connection = db;
    db = undefined;
    await connection?.close();
  });
  return () => {
    if (!db) throw new Error("Database requested before beforeAll");
    return db;
  };
}
