import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { HARNESSES, type SandboxState, type Visibility } from "../src/index.ts";

const PROVIDER_STATES = [
  "starting",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
] as const satisfies readonly SandboxState[];
const VISIBILITIES = ["org", "private"] as const satisfies readonly Visibility[];

/** Fails to compile when SandboxState gains a state the schema test does not know. */
function assertStatesCovered(_missing: Exclude<SandboxState, (typeof PROVIDER_STATES)[number]>): void {
  void _missing;
}

assertStatesCovered(undefined as never);

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
let connection: PGlite | undefined;
beforeAll(async () => {
  connection = await openDatabase();
});
afterAll(async () => {
  const db = connection;
  connection = undefined;
  await db?.close();
});

test("migrations apply on a fresh database", async () => {
  const db = connection;
  if (!db) throw new Error("Migration fixture is not open");
  expect(files.every((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))).toBe(true);
  expect(await applyMigrations(db)).toEqual(files);

  const unlocked = await db.query<{ name: string }>(`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
  expect(unlocked.rows).toEqual([]);

  expect(await labels(db, "harness")).toEqual([...HARNESSES]);
  expect(await labels(db, "visibility")).toEqual([...VISIBILITIES]);
  expect(await labels(db, "sandbox_status")).toEqual([...PROVIDER_STATES, "deleted"]);
  expect(await labels(db, "member_role")).toEqual(["admin", "member"]);
  expect(await labels(db, "credential_scope")).toEqual(["user", "org"]);
  expect(await labels(db, "credential_kind")).toEqual([
    "anthropic",
    "openai",
    "claude_oauth",
    "boat",
    "codex_auth",
    "modal",
    "skillpack",
    "opencode",
    "morph",
  ]);
  expect(await labels(db, "notify_status")).toEqual(["finished", "failed"]);
});

async function labels(db: PGlite, name: string): Promise<string[]> {
  const result = await db.query<{ label: string }>(
    `select e.enumlabel as label
     from pg_type t
     join pg_enum e on e.enumtypid = t.oid
     join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typname = $1
     order by e.enumsortorder`,
    [name],
  );
  return result.rows.map((row) => row.label);
}
