import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { closeableFixture } from "../../mcp-server/test/closeable.fixture.ts";

const IDENTITY = "20261109010000_sandbox_provider_identity.sql";
const CONFIG = JSON.stringify({
  repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
  init: [],
});

// The database as the previous release left it.
const database = closeableFixture(async () => {
  const db = await openDatabase();
  try {
    await applyUpTo(db, IDENTITY);
    return db;
  } catch (error) {
    try {
      await db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Provider schema fixture setup and cleanup failed");
    }
    throw error;
  }
});
beforeAll(database.setup);
afterAll(database.close);

describe("legacy upgrade", () => {
  test("existing goldens and sandboxes are backfilled to Boat with their ids", async () => {
    const db = database.get();
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

    await db.exec(await Bun.file(join(migrationsDir, IDENTITY)).text());
    expect(
      (await db.query("select provider::text, provider_sandbox_id, provider_snapshot_id, modal_app_id from goldens"))
        .rows,
    ).toEqual([
      { provider: "boat", provider_sandbox_id: "bx_builder", provider_snapshot_id: "snap-1", modal_app_id: null },
    ]);
    expect((await db.query("select provider::text, provider_sandbox_id, boat_id from sandboxes")).rows).toEqual([
      { provider: "boat", provider_sandbox_id: "bx_old", boat_id: "bx_old" },
    ]);
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
