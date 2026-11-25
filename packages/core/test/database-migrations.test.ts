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
    "antigravity",
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

test("publishing a sandbox prompt records the queue receipt without writing a retired webhook receipt", async () => {
  const db = migrationDatabase.get();
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const golden = crypto.randomUUID();
  const sandbox = crypto.randomUUID();
  const account = crypto.randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [owner]);
  await db.query("insert into public.orgs(id,name) values ($1,'Queue fixture')", [org]);
  await db.query(
    "insert into public.goldens(id,org_id,name,boat_snapshot_id,visibility,owner_id) values ($1,$2,'Queue fixture','snapshot','org',$3)",
    [golden, org, owner],
  );
  await db.query("insert into public.credentials(id,scope,owner_id,kind,value_enc) values ($1,'user',$2,'openai',$3)", [
    account,
    owner,
    new Uint8Array([1]),
  ]);
  await db.query(
    `insert into public.sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status)
     values ($1,'boat','queue-fixture',$2,$3,$4,'codex','ready')`,
    [sandbox, golden, org, owner],
  );
  await db.query(
    `insert into public.account_turn_queue(sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,
       credential_version,input_hash,input_enc,conversation_id,state)
     values ($1,$2,$3,$4,$5,1,1,'fixture',$6,'conversation','dispatching')`,
    [sandbox, crypto.randomUUID(), account, owner, org, new Uint8Array([1])],
  );

  await db.query("update public.sandboxes set task_prompt_id='published-prompt' where id=$1", [sandbox]);

  const { rows } = await db.query(
    `select native_prompt_id,
       exists(select 1 from public.native_webhook_prompts p where p.sandbox_id=q.sandbox_id) as webhook_receipt
     from public.account_turn_queue q where sandbox_id=$1`,
    [sandbox],
  );
  expect(rows).toEqual([{ native_prompt_id: "published-prompt", webhook_receipt: false }]);
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
