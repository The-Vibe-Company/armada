import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";

const IDENTITY = "20261109010000_sandbox_provider_identity.sql";
const CONFIG = JSON.stringify({
  repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
  init: [],
});

function isolatedDatabase(open: () => Promise<PGlite>, prepare?: (db: PGlite) => Promise<void>) {
  let connection: PGlite | undefined;
  beforeAll(async () => {
    const db = await open();
    connection = db;
    await prepare?.(db);
  });
  afterAll(async () => {
    const db = connection;
    connection = undefined;
    await db?.close();
  });
  return () => {
    if (!connection) throw new Error("Missing provider schema fixture");
    return connection;
  };
}

describe("legacy upgrade", () => {
  // The database as the previous release left it.
  const getDatabase = isolatedDatabase(openDatabase, (db) => applyUpTo(db, IDENTITY));

  test("existing goldens and sandboxes are backfilled to Boat with their ids, and server writes keep Boat aliases compatible", async () => {
    const db = getDatabase();
    const people = await fixture(db);
    const golden = await db.query<{ id: string }>(
      `insert into goldens (org_id, name, visibility, owner_id, boat_sandbox_id, boat_snapshot_id, config)
           values ($1, 'web', 'org', $2, 'bx_builder', 'snap-1', $3::jsonb) returning id`,
      [people.org, people.admin, CONFIG],
    );
    const goldenId = golden.rows[0]?.id;
    await db.query(
      `insert into sandboxes (boat_id, golden_id, org_id, owner_id, harness, status)
           values ('bx_old', $1, $2, $3, 'claude', 'ready')`,
      [goldenId, people.org, people.member],
    );

    await applyFrom(db, IDENTITY);
    expect(
      (await db.query("select provider::text, provider_sandbox_id, provider_snapshot_id, modal_app_id from goldens"))
        .rows,
    ).toEqual([
      { provider: "boat", provider_sandbox_id: "bx_builder", provider_snapshot_id: "snap-1", modal_app_id: null },
    ]);
    expect((await db.query("select provider::text, provider_sandbox_id, boat_id from sandboxes")).rows).toEqual([
      { provider: "boat", provider_sandbox_id: "bx_old", boat_id: "bx_old" },
    ]);

    // A client of the previous release writes boat_* columns; a new one the neutral ones. Both stay one id.
    await asUser(db, people.admin, () =>
      db.query("update goldens set boat_snapshot_id = 'snap-2' where id = $1", [goldenId]),
    );
    // Trusted server writes retain the legacy Boat alias contract.
    await db.query(
      `insert into sandboxes (boat_id, golden_id, org_id, owner_id, harness, status)
           values ('bx_legacy', $1, $2, $3, 'claude', 'starting')`,
      [goldenId, people.org, people.admin],
    );
    expect((await db.query("select provider_snapshot_id, boat_snapshot_id from goldens")).rows).toEqual([
      { provider_snapshot_id: "snap-2", boat_snapshot_id: "snap-2" },
    ]);
    expect(
      (await db.query("select provider::text, provider_sandbox_id from sandboxes where boat_id = 'bx_legacy'")).rows,
    ).toEqual([{ provider: "boat", provider_sandbox_id: "bx_legacy" }]);
  });
});

type People = { org: string; member: string; admin: string };
async function fixture(db: PGlite): Promise<People> {
  const people = { org: crypto.randomUUID(), member: crypto.randomUUID(), admin: crypto.randomUUID() };
  for (const user of [people.member, people.admin]) await db.query("insert into auth.users (id) values ($1)", [user]);
  await db.query("insert into orgs (id, name) values ($1, 'Example')", [people.org]);
  await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')", [
    people.org,
    people.member,
    people.admin,
  ]);
  return people;
}
const PREREQ = fileURLToPath(new URL("../../../scripts/db/supabase-prereq.sql", import.meta.url));
function migrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}
async function applyUpTo(db: PGlite, first: string): Promise<void> {
  await db.exec(await Bun.file(PREREQ).text());
  for (const file of migrations().filter((name) => name < first)) {
    await db.exec(await Bun.file(join(migrationsDir, file)).text());
  }
}
async function applyFrom(db: PGlite, first: string): Promise<void> {
  for (const file of migrations().filter((name) => name >= first)) {
    await db.exec(await Bun.file(join(migrationsDir, file)).text());
  }
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
