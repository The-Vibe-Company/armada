import { expect, test } from "bun:test";
import { DB_MIGRATIONS, DB_SCHEMA_VERSION, migrateDatabase, pgliteDatabase } from "../lib/db.ts";

const now = new Date("2026-01-01T12:00:00Z");

test("migrations apply a missing lower version after a higher version has landed", async () => {
  const db = await pgliteDatabase();
  try {
    await db.query("CREATE TABLE armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
    // Reservations (27) and validation samples (29) can land from different workers.
    for (const migration of DB_MIGRATIONS.filter((m) => m.version !== 27)) {
      for (const statement of migration.statements) await db.query(statement);
      await db.query("INSERT INTO armada_migrations (version, applied_at) VALUES ($1, $2)", [migration.version, now]);
    }
    expect((await db.query("SELECT to_regclass('reservations') AS name")).rows).toEqual([{ name: null }]);
    expect(await migrateDatabase(db, now)).toBe(DB_SCHEMA_VERSION);
    expect((await db.query("SELECT to_regclass('reservations') AS name")).rows).toEqual([{ name: "reservations" }]);
    const applied = await db.query("SELECT version, applied_at FROM armada_migrations ORDER BY version");
    expect(applied.rows).toEqual(DB_MIGRATIONS.map((m) => ({ version: m.version, applied_at: now })));
    await migrateDatabase(db, new Date("2026-01-02T12:00:00Z"));
    expect((await db.query("SELECT version, applied_at FROM armada_migrations ORDER BY version")).rows).toEqual(
      applied.rows,
    );
  } finally {
    await db.end();
  }
});

test.each(["empty", "version 21", "version 21 without the retired table"])(
  "migrations remove retired views from %s and preserve accounts",
  async (startingAt) => {
    const db = await pgliteDatabase();
    try {
      let ownedRelations: string[] = [];
      if (startingAt !== "empty") {
        await db.query("CREATE TABLE armada_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
        for (const migration of DB_MIGRATIONS.filter((m) => m.version <= 21)) {
          for (const statement of migration.statements) await db.query(statement);
          await db.query("INSERT INTO armada_migrations (version, applied_at) VALUES ($1, $2)", [
            migration.version,
            now,
          ]);
        }
        await db.query(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified")
           VALUES ('person-1', 'Ada Example', 'ada@example.test', true)`,
        );
        await db.query(
          `INSERT INTO "organization" ("id", "name", "slug", "createdAt")
           VALUES ('org-1', 'Example', 'example', $1)`,
          [now],
        );
        await db.query(
          `INSERT INTO saved_views (organization, person, name, list, query, created_at)
           VALUES ('org-1', 'person-1', 'My project', 'activity', 'project=example', $1)`,
          [now],
        );
        const indexes = await db.query<{ name: string }>(
          "SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid = 'saved_views'::regclass",
        );
        const sequence = await db.query<{ name: string }>("SELECT pg_get_serial_sequence('saved_views', 'id') AS name");
        ownedRelations = [...indexes.rows, ...sequence.rows].map((r) => r.name);
        expect(ownedRelations.length).toBe(3);
        if (startingAt === "version 21 without the retired table") await db.query("DROP TABLE saved_views");
      }

      expect(await migrateDatabase(db, now)).toBe(DB_SCHEMA_VERSION);
      expect((await db.query("SELECT to_regclass('saved_views') AS name")).rows).toEqual([{ name: null }]);
      for (const name of ownedRelations)
        expect((await db.query("SELECT to_regclass($1) AS name", [name])).rows).toEqual([{ name: null }]);
      const migrations = await db.query("SELECT version, applied_at FROM armada_migrations ORDER BY version");
      expect(migrations.rows).toEqual(DB_MIGRATIONS.map((m) => ({ version: m.version, applied_at: now })));
      if (startingAt !== "empty") {
        expect((await db.query('SELECT "id", "email" FROM "user"')).rows).toEqual([
          { id: "person-1", email: "ada@example.test" },
        ]);
        expect((await db.query('SELECT "id", "slug" FROM "organization"')).rows).toEqual([
          { id: "org-1", slug: "example" },
        ]);
      }
      expect(await migrateDatabase(db, new Date("2026-01-02T12:00:00Z"))).toBe(DB_SCHEMA_VERSION);
      expect((await db.query("SELECT version, applied_at FROM armada_migrations ORDER BY version")).rows).toEqual(
        migrations.rows,
      );
    } finally {
      await db.end();
    }
  },
);
