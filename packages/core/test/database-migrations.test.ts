import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { closeableFixture } from "../../mcp-server/test/closeable.fixture.ts";
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

// WARNING: Remove these reserved labels in #3704 part 2 to avoid counting Antigravity twice.
const RESERVED_ENUM_LABELS = ["antigravity"] as const;

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationDatabase = closeableFixture(openDatabase);
const credentialDatabase = closeableFixture(() => migrationDatabase.get().clone());
beforeAll(async () => {
  await migrationDatabase.setup();
  expect(await applyMigrations(migrationDatabase.get())).toEqual(files);
  await credentialDatabase.setup();
});
afterAll(credentialDatabase.close);
afterAll(migrationDatabase.close);

test("migrations apply on a fresh database", async () => {
  const db = migrationDatabase.get();
  expect(files.every((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))).toBe(true);

  const unlocked = await db.query<{ name: string }>(`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
  expect(unlocked.rows).toEqual([]);

  expect(await labels(db, "harness")).toEqual([...HARNESSES, ...RESERVED_ENUM_LABELS]);
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
    ...RESERVED_ENUM_LABELS,
  ]);
  expect(await labels(db, "notify_status")).toEqual(["finished", "failed"]);
});

test.each(["fixture_model_account", "antigravity"])(
  "authenticated owners cannot directly write %s credentials",
  async (kind) => {
    const db = credentialDatabase.get();
    if (kind === "fixture_model_account") {
      await db.exec("alter type public.credential_kind add value 'fixture_model_account'");
    }
    const owner = crypto.randomUUID();
    await db.query("insert into auth.users(id) values ($1)", [owner]);
    const insert = "insert into public.credentials(scope, owner_id, kind, value_enc) values ('user', $1, $2, $3)";
    const stored = new Uint8Array([1]);
    const attempted = new Uint8Array([2]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);

    await db.exec("set role authenticated");
    try {
      await expect(db.query(insert, [owner, kind, attempted])).rejects.toThrow(/row-level security/);
    } finally {
      await db.exec("reset role");
    }

    await db.query(insert, [owner, kind, stored]);
    await db.exec("set role authenticated");
    try {
      const rotate = await db.query("update public.credentials set value_enc = $1 where owner_id = $2", [
        attempted,
        owner,
      ]);
      const remove = await db.query("delete from public.credentials where owner_id = $1", [owner]);
      expect([rotate.affectedRows, remove.affectedRows]).toEqual([0, 0]);
    } finally {
      await db.exec("reset role");
    }
  },
);

test("Antigravity can be stored as an agent default", async () => {
  const db = credentialDatabase.get();
  const owner = crypto.randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  const result = await db.query(
    "insert into public.agent_defaults(user_id,harness,model) values ($1,'antigravity','default') returning harness",
    [owner],
  );
  expect(result.rows).toEqual([{ harness: "antigravity" }]);
});

test("an inbound trigger can bind an Antigravity pool", async () => {
  const db = credentialDatabase.get();
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const template = crypto.randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  await db.query("insert into public.orgs(id,name) values ($1,'Trigger fixture')", [org]);
  await db.query(
    "insert into public.launch_templates(id,org_id,owner_id,scope,name) values ($1,$2,$3,'org','Trigger template')",
    [template, org, owner],
  );
  const result = await db.query(
    `insert into public.triggers(org_id,template_id,launch_owner_id,pool_harness,secret_enc,rate_per_minute,concurrency)
     values ($1,$2,$3,'antigravity',$4,1,1) returning pool_harness`,
    [org, template, owner, new Uint8Array([1])],
  );
  expect(result.rows).toEqual([{ pool_harness: "antigravity" }]);
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
