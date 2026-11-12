import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { generateDatabaseTypes } from "../../../scripts/db/generate.ts";
import { encryptSecret, HARNESSES, type SandboxState, type Visibility } from "../src/index.ts";

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

const HASH = "ab".repeat(32);
const PLAIN_CONFIG = {
  repos: [{ url: "https://example.com/app.git", branch: "main" }],
  init: ["pnpm i"],
};

type Fixture = {
  org: string;
  owner: string;
  member: string;
  admin: string;
  outsider: string;
};

describe("database", () => {
  test("migrations apply on a fresh database", async () => {
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files.every((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))).toBe(true);

    const db = await openDatabase();
    try {
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
      ]);
      expect(await labels(db, "notify_status")).toEqual(["finished", "failed"]);
    } finally {
      await db.close();
    }
  });

  test("generated types match the migrations", async () => {
    const generated = await generateDatabaseTypes();
    const committed = await Bun.file(new URL("../src/database.types.ts", import.meta.url)).text();
    expect(committed).toBe(generated);
  });

  test("anon holds nothing, and a user JWT has only the intended grants and never reads a secret", async () => {
    await withDb(async (db) => {
      const anon = await db.query<{ object: string }>(`
        select c.relname as object
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'S')
          and (has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
            or has_any_column_privilege('anon', c.oid, 'select, insert, update, references'))
        union all
        select p.oid::regprocedure::text
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
      `);
      expect(anon.rows).toEqual([]);

      // Every privilege authenticated holds on a public table: what the migrations grant, and nothing
      // Supabase's default privileges add.
      const granted = await db.query<{ grant: string }>(`
        select format('%s %s%s', c.relname, p.privilege, coalesce('(' || p.columns || ')', '')) as grant
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral (
          select t.privilege, null::text as columns
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as t(privilege)
          where has_table_privilege('authenticated', c.oid, t.privilege)
          union all
          select t.privilege, string_agg(a.attname, ',' order by a.attname)
          from unnest(array['SELECT', 'INSERT', 'UPDATE']) as t(privilege)
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where not has_table_privilege('authenticated', c.oid, t.privilege)
            and has_column_privilege('authenticated', c.oid, a.attnum, t.privilege)
          group by t.privilege
        ) p
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1
      `);
      expect(granted.rows.map((row) => row.grant)).toEqual([
        "application_secrets SELECT(created_at,epoch,expires_at,id,name,org_id,owner_id,scope,status,updated_at,version)",
        "application_vault_audit SELECT",
        "credentials DELETE",
        "credentials INSERT(created_at,id,kind,owner_id,scope,value_enc)",
        "credentials SELECT(created_at,expires_at,id,is_default,kind,name,owner_id,scope,status,updated_at,version)",
        "credentials UPDATE(value_enc)",
        "github_connections DELETE",
        "github_connections SELECT(created_at,github_id,installations,login,name,refresh_expires_at,revoked_at,updated_at,user_id)",
        "golden_skill_defaults SELECT",
        "goldens DELETE",
        "goldens INSERT(boat_sandbox_id,boat_snapshot_id,config,created_at,id,modal_app_id,modal_environment,modal_workspace,name,org_id,owner_id,provider,provider_sandbox_id,provider_snapshot_id,removed_at,size_policy,visibility)",
        "goldens SELECT",
        "goldens UPDATE(boat_sandbox_id,boat_snapshot_id,config,name,provider_sandbox_id,provider_snapshot_id)",
        "launch_template_revisions SELECT",
        "launch_templates SELECT",
        "mcp_connections SELECT",
        "mcp_tokens DELETE",
        "mcp_tokens SELECT(created_at,id,label,org_id,revoked_at,user_id)",
        "mcp_tokens UPDATE(revoked_at)",
        "members DELETE",
        "members INSERT(created_at,org_id,role,user_id)",
        "members SELECT",
        "members UPDATE(role)",
        "notify_subscriptions DELETE",
        "notify_subscriptions INSERT(created_at,last_cursor,last_status,sandbox_id,secret_enc,url)",
        "notify_subscriptions SELECT(created_at,last_cursor,last_status,sandbox_id,url)",
        "notify_subscriptions UPDATE(last_cursor,last_status,secret_enc,url)",
        "orchestrator_child_operations SELECT",
        "orchestrator_children SELECT",
        "orchestrator_lifecycle SELECT",
        "orchestrator_lifecycle_mutations SELECT",
        "orchestrator_operations SELECT",
        "orchestrator_waits SELECT",
        "orchestrators SELECT",
        "org_skill_defaults SELECT",
        "orgs DELETE",
        "orgs SELECT(created_at,id,name)",
        "orgs UPDATE(boat_api_key_enc,name)",
        "personal_skill_defaults SELECT",
        "readable_variables SELECT",
        "routine_runs SELECT(configuration_version,created_at,id,missed_count_capped,missed_intervals,org_id,owner_id,reason,request_key,routine_id,scheduled_due_at,state,task_checked_at,task_state,template_request_id,updated_at)",
        "routines SELECT",
        "sandboxes SELECT",
        "sandboxes UPDATE(conversation_ids,deleted_at,status,status_reason,stopped_at)",
        "service_tokens DELETE",
        "service_tokens INSERT",
        "service_tokens SELECT(created_at,id,label,org_id,revoked_at,user_id)",
        "service_tokens UPDATE(revoked_at)",
        "template_launch_requests SELECT",
      ]);

      // Whatever else is granted, no SELECT grant of a user JWT names a secret column.
      const secretSelects = granted.rows.filter((row) => /SELECT\(.*\b(hash|\w+_enc)\b/.test(row.grant));
      expect(secretSelects).toEqual([]);

      // A table or function created by a later migration starts with nothing for anon or a user JWT.
      await db.exec("create table public.later (id int primary key, value_enc bytea)");
      await db.exec("create function public.later_fn() returns int language sql as 'select 1'");
      const later = await db.query<{ any: boolean }>(
        `select has_table_privilege('authenticated', 'public.later', 'select, insert, update, delete, truncate')
            or has_table_privilege('anon', 'public.later', 'select, insert, update, delete, truncate')
            or has_function_privilege('anon', 'public.later_fn()', 'execute') as any`,
      );
      expect(later.rows[0]?.any).toBe(false);
    });
  });

  test("no column stores a secret in plaintext", async () => {
    await withDb(async (db) => {
      const columns = await db.query<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(`
        select table_name, column_name, data_type, udt_name
        from information_schema.columns
        where table_schema = 'public'
      `);
      const secretName = /secret|password|passwd|token|api_key|apikey|credential|private_key/i;
      const ciphertext: string[] = [];
      for (const column of columns.rows) {
        const id = `${column.table_name}.${column.column_name}`;
        if (column.column_name.endsWith("_enc")) {
          expect({ id, type: column.data_type }).toEqual({ id, type: "bytea" });
          ciphertext.push(id);
        }
        if (!secretName.test(column.column_name)) continue;
        if (
          id === "sandboxes.credential_id" ||
          id === "sandboxes.credential_version" ||
          id === "modal_server_harnesses.credential_id" ||
          id === "modal_server_harnesses.credential_version"
        ) {
          expect(column.data_type).toBe(id.endsWith("_id") ? "uuid" : "integer");
          continue;
        }
        if (id === "armada_access_parents.credential_ids") {
          // Allowlisted account references are UUIDs, never credential values.
          expect(column.data_type).toBe("ARRAY");
          expect(column.udt_name).toBe("_uuid");
          continue;
        }
        if (id === "sandboxes.application_secret_tainted") {
          // Exposure metadata is a boolean, never a plaintext secret payload.
          expect(column.data_type).toBe("boolean");
          continue;
        }
        if (id === "application_secret_uploads.secret_expires_at") {
          expect(column.data_type).toBe("timestamp with time zone");
          continue;
        }
        if (column.column_name === "hash") {
          expect(column.data_type).toBe("text");
          continue;
        }
        expect({ id, encrypted: column.column_name.endsWith("_enc"), type: column.data_type }).toEqual({
          id,
          encrypted: true,
          type: "bytea",
        });
      }
      expect(ciphertext.sort()).toEqual([
        "application_secret_uploads.value_enc",
        "application_secrets.value_enc",
        "credentials.value_enc",
        "github_connections.access_token_enc",
        "github_connections.refresh_token_enc",
        "github_runtime_issued.token_enc",
        "golden_build_jobs.payload_enc",
        "mcp_grants.value_enc",
        "mcp_pending_oauth.payload_enc",
        "model_auth_state.state_enc",
        "notify_subscriptions.secret_enc",
        "organization_invitations.token_enc",
        "orgs.boat_api_key_enc",
        "runtime_enrolments.configuration_enc",
        "sandbox_work_recovery.archive_enc",
      ]);

      const checks = await db.query<{ def: string }>(`
        select pg_get_constraintdef(oid) as def
        from pg_constraint
        where conname in ('service_tokens_hash_chk', 'mcp_tokens_hash_chk', 'oauth_codes_hash_chk')
      `);
      expect(checks.rows).toHaveLength(3);
      for (const row of checks.rows) expect(row.def).toContain("^[0-9a-f]{64}$");

      const people = await fixture(db);
      await db.query("insert into service_tokens (user_id, org_id, hash, label) values ($1, $2, $3, 'worker')", [
        people.owner,
        people.org,
        HASH,
      ]);
      await expect(
        db.query("insert into mcp_tokens (user_id, org_id, hash, label) values ($1, $2, 'plaintext-token', 'worker')", [
          people.owner,
          people.org,
        ]),
      ).rejects.toThrow(/mcp_tokens_hash_chk/);

      await db.query(
        `insert into goldens (org_id, name, visibility, owner_id, config)
         values ($1, 'plain', 'org', $2, $3::jsonb)`,
        [people.org, people.owner, JSON.stringify(PLAIN_CONFIG)],
      );
      await expect(
        db.query(
          `insert into goldens (org_id, name, visibility, owner_id, config)
           values ($1, 'leaky', 'org', $2, '{"api_key":"nope"}'::jsonb)`,
          [people.org, people.owner],
        ),
      ).rejects.toThrow(/must not contain secrets/);
      await expect(
        db.query(
          `insert into goldens (org_id, name, visibility, owner_id, config)
           values ($1, 'nested', 'org', $2, '{"env":{"token":"nope"}}'::jsonb)`,
          [people.org, people.owner],
        ),
      ).rejects.toThrow(/must not contain secrets/);

      await db.query("update orgs set boat_api_key_enc = decode('0102', 'hex') where id = $1", [people.org]);
      const visible = await asUser(db, people.member, () => ids(db, "select id from orgs where id = $1", [people.org]));
      expect(visible).toEqual([people.org]);
      // Column grants refuse the ciphertext. Postgres reports that as a table denial.
      await expect(
        asUser(db, people.member, () => db.query("select boat_api_key_enc from orgs where id = $1", [people.org])),
      ).rejects.toThrow(/permission denied for table orgs/);
      await expect(asUser(db, people.owner, () => db.query("select value_enc from credentials"))).rejects.toThrow(
        /permission denied for table credentials/,
      );
      await expect(
        asUser(db, people.owner, () => db.query("select secret_enc from notify_subscriptions")),
      ).rejects.toThrow(/permission denied for table notify_subscriptions/);

      const stored = await asRole(db, "service_role", async () => {
        const result = await db.query<{ hex: string | null }>(
          "select encode(boat_api_key_enc, 'hex') as hex from orgs where id = $1",
          [people.org],
        );
        return result.rows[0]?.hex ?? null;
      });
      expect(stored).toBe("0102");
    });
  });

  test("a member does not see another member's private golden", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const shared = await insertGolden(db, people, { name: "shared", visibility: "org", owner: people.admin });
      expect(await asUser(db, people.member, () => ids(db, "select id from goldens where id = $1", [shared]))).toEqual([
        shared,
      ]);

      const hidden = await asUser(db, people.owner, () =>
        insertGolden(db, people, { name: "kept", visibility: "private", owner: people.owner }),
      );
      expect(await asUser(db, people.owner, () => ids(db, "select id from goldens where id = $1", [hidden]))).toEqual([
        hidden,
      ]);
      expect(await asUser(db, people.member, () => ids(db, "select id from goldens where id = $1", [hidden]))).toEqual(
        [],
      );

      // Registration is trusted; the assertions below still exercise user-role visibility.
      const sandbox = await insertSandbox(db, people, hidden, people.owner);
      expect(
        await asUser(db, people.owner, () => ids(db, "select id from sandboxes where id = $1", [sandbox])),
      ).toEqual([sandbox]);
      expect(
        await asUser(db, people.member, () => ids(db, "select id from sandboxes where id = $1", [sandbox])),
      ).toEqual([]);
    });
  });

  test("an admin does not see another member's private golden", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const shared = await insertGolden(db, people, { name: "shared", visibility: "org", owner: people.admin });
      expect(await asUser(db, people.admin, () => ids(db, "select id from goldens where id = $1", [shared]))).toEqual([
        shared,
      ]);

      const hidden = await insertGolden(db, people, { name: "kept", visibility: "private", owner: people.owner });
      expect(await asUser(db, people.owner, () => ids(db, "select id from goldens where id = $1", [hidden]))).toEqual([
        hidden,
      ]);
      expect(await asUser(db, people.admin, () => ids(db, "select id from goldens where id = $1", [hidden]))).toEqual(
        [],
      );

      await asUser(db, people.admin, () => db.query("update goldens set name = 'taken' where id = $1", [hidden]));
      expect(
        await asUser(db, people.owner, () => text(db, "select name as value from goldens where id = $1", [hidden])),
      ).toBe("kept");

      const sandbox = await insertSandbox(db, people, hidden, people.owner);
      expect(
        await asUser(db, people.owner, () => ids(db, "select id from sandboxes where id = $1", [sandbox])),
      ).toEqual([sandbox]);
      expect(
        await asUser(db, people.admin, () => ids(db, "select id from sandboxes where id = $1", [sandbox])),
      ).toEqual([sandbox]);
      await asUser(db, people.admin, () =>
        db.query("update sandboxes set status = 'stopped', stopped_at = now() where id = $1", [sandbox]),
      );
      expect(
        await asUser(db, people.owner, () =>
          text(db, "select status::text as value from sandboxes where id = $1", [sandbox]),
        ),
      ).toBe("stopped");
    });
  });

  test("a non-member sees nothing of an org", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const other = crypto.randomUUID();
      await db.query("insert into orgs (id, name) values ($1, 'Other Org')", [other]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [other, people.outsider]);

      const golden = await insertGolden(db, people, { name: "shared", visibility: "org", owner: people.admin });
      const sandbox = await insertSandbox(db, people, golden, people.member);
      await db.query(
        "insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'anthropic', decode('0b', 'hex'))",
        [people.org],
      );
      await db.query(
        "insert into notify_subscriptions (sandbox_id, url, secret_enc) values ($1, 'https://example.com/hooks/armada', decode('0c', 'hex'))",
        [sandbox],
      );
      await db.query("insert into service_tokens (user_id, org_id, hash, label) values ($1, $2, $3, 'worker')", [
        people.member,
        people.org,
        HASH,
      ]);

      expect(await asUser(db, people.member, () => ids(db, "select id from orgs where id = $1", [people.org]))).toEqual(
        [people.org],
      );
      expect(await asUser(db, people.member, () => ids(db, "select id from goldens where id = $1", [golden]))).toEqual([
        golden,
      ]);
      expect(
        await asUser(db, people.member, () => ids(db, "select id from sandboxes where id = $1", [sandbox])),
      ).toEqual([sandbox]);
      expect(
        await asUser(db, people.member, () =>
          ids(db, "select user_id as id from members where org_id = $1 and user_id = $2", [people.org, people.owner]),
        ),
      ).toEqual([people.owner]);
      const credential = await asUser(db, people.member, () =>
        ids(db, "select id from credentials where scope = 'org' and owner_id = $1", [people.org]),
      );
      expect(credential).toHaveLength(1);
      expect(
        await asUser(db, people.member, () =>
          ids(db, "select sandbox_id as id from notify_subscriptions where sandbox_id = $1", [sandbox]),
        ),
      ).toEqual([sandbox]);

      expect(await asUser(db, people.outsider, () => ids(db, "select id from orgs where id = $1", [other]))).toEqual([
        other,
      ]);
      expect(
        await asUser(db, people.outsider, () => ids(db, "select id from orgs where id = $1", [people.org])),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () => ids(db, "select id from goldens where org_id = $1", [people.org])),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () => ids(db, "select id from sandboxes where org_id = $1", [people.org])),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () =>
          ids(db, "select user_id as id from members where org_id = $1", [people.org]),
        ),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () =>
          ids(db, "select id from credentials where owner_id = $1", [people.org]),
        ),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () =>
          ids(db, "select sandbox_id as id from notify_subscriptions where sandbox_id = $1", [sandbox]),
        ),
      ).toEqual([]);
      expect(
        await asUser(db, people.outsider, () =>
          ids(db, "select id from service_tokens where org_id = $1", [people.org]),
        ),
      ).toEqual([]);
    });
  });

  test("only an admin changes an org golden, its members and its org key", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const golden = await insertGolden(db, people, { name: "shared", visibility: "org", owner: people.admin });
      expect(
        await asUser(db, people.member, () => text(db, "select name as value from goldens where id = $1", [golden])),
      ).toBe("shared");

      await asUser(db, people.member, () => db.query("update goldens set name = 'nope' where id = $1", [golden]));
      expect(
        await asUser(db, people.member, () => text(db, "select name as value from goldens where id = $1", [golden])),
      ).toBe("shared");
      await asUser(db, people.admin, () => db.query("update goldens set name = 'renamed' where id = $1", [golden]));
      expect(
        await asUser(db, people.member, () => text(db, "select name as value from goldens where id = $1", [golden])),
      ).toBe("renamed");

      await expect(
        asUser(db, people.member, () =>
          db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member')", [
            people.org,
            people.outsider,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
      await asUser(db, people.admin, () =>
        db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member')", [
          people.org,
          people.outsider,
        ]),
      );
      expect(
        await asUser(db, people.outsider, () => ids(db, "select id from orgs where id = $1", [people.org])),
      ).toEqual([people.org]);

      await expect(
        asUser(db, people.member, () =>
          db.query(
            "insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'modal', decode('0a', 'hex'))",
            [people.org],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const credential = await asUser(db, people.admin, async () => {
        const result = await db.query<{ id: string }>(
          `insert into credentials (scope, owner_id, kind, value_enc)
           values ('org', $1, 'modal', decode('0a', 'hex'))
           returning id`,
          [people.org],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("org credential insert returned no id");
        return id;
      });
      expect(
        await asUser(db, people.member, () =>
          text(db, "select kind::text as value from credentials where id = $1", [credential]),
        ),
      ).toBe("modal");
      await asUser(db, people.member, () =>
        db.query("update credentials set value_enc = decode('ff', 'hex') where id = $1", [credential]),
      );
      expect(await ciphertext(db, credential)).toBe("0a");
      await asUser(db, people.admin, () =>
        db.query("update credentials set value_enc = decode('0b', 'hex') where id = $1", [credential]),
      );
      expect(await ciphertext(db, credential)).toBe("0b");

      await expect(
        asUser(db, people.admin, () => db.query("insert into orgs (name) values ('Second Org')")),
      ).rejects.toThrow(/permission denied/);

      const sandbox = await insertSandbox(db, people, golden, people.member);
      await asUser(db, people.member, () =>
        db.query("update sandboxes set status = 'stopped', stopped_at = now() where id = $1", [sandbox]),
      );
      expect(
        await asUser(db, people.member, () =>
          text(db, "select status::text as value from sandboxes where id = $1", [sandbox]),
        ),
      ).toBe("stopped");
    });
  });

  test("a GitHub connection is its owner's: nobody else sees it, and a user JWT never reads the ciphertext", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const save = "select public.save_github_connection($1, $2, null, decode($3, 'hex'), null)";
      await asUser(db, people.owner, () => db.query(save, [1, "first", "0c"]));
      await asUser(db, people.owner, () => db.query(save, [583231, "octocat", "0d"]));
      expect(
        await asRole(db, "service_role", () =>
          db.query("select github_id, encode(refresh_token_enc, 'hex') as enc from github_connections"),
        ),
      ).toMatchObject({ rows: [{ github_id: 583231, enc: "0d" }] });

      // A user JWT writes no column directly: connecting goes through save_github_connection.
      await expect(
        asUser(db, people.member, () =>
          db.query(
            `insert into github_connections (user_id, github_id, login, refresh_token_enc)
             values ($1, 1, 'impostor', decode('0d', 'hex'))`,
            [people.member],
          ),
        ),
      ).rejects.toThrow(/permission denied for table github_connections/);
      await expect(
        asUser(db, people.owner, () =>
          db.query("update github_connections set refresh_token_enc = decode('0e', 'hex')"),
        ),
      ).rejects.toThrow(/permission denied for table github_connections/);

      const login = "select login as value from github_connections where user_id = $1";
      expect(await asUser(db, people.owner, () => text(db, login, [people.owner]))).toBe("octocat");
      for (const other of [people.member, people.admin, people.outsider]) {
        expect(await asUser(db, other, () => db.query(login, [people.owner]))).toMatchObject({ rows: [] });
      }
      await expect(
        asUser(db, people.owner, () => db.query("select refresh_token_enc from github_connections")),
      ).rejects.toThrow(/permission denied for table github_connections/);
      await expect(
        asUser(db, people.owner, () => db.query("select access_token_enc from github_connections")),
      ).rejects.toThrow(/permission denied for table github_connections/);

      await asUser(db, people.member, () =>
        db.query("delete from github_connections where user_id = $1", [people.owner]),
      );
      expect(await asRole(db, "service_role", () => text(db, login, [people.owner]))).toBe("octocat");

      await asUser(db, people.owner, () =>
        db.query("delete from github_connections where user_id = $1", [people.owner]),
      );
      expect(await asRole(db, "service_role", () => db.query(login, [people.owner]))).toMatchObject({ rows: [] });
    });
  });

  test("a connection records which accounts have the GitHub App installed, and that list is not a secret", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const save = "select public.save_github_connection($1, $2, null, decode($3, 'hex'), null, $4::jsonb)";
      const list = JSON.stringify([
        { id: 7, account: "acme", account_type: "Organization", repository_selection: "selected" },
      ]);
      await asUser(db, people.owner, () => db.query(save, [583231, "octocat", "0d", list]));
      const stored = await asUser(db, people.owner, () =>
        text(db, "select installations::text as value from github_connections", []),
      );
      expect(JSON.parse(stored ?? "null")).toEqual(JSON.parse(list));
      expect(
        await asUser(db, people.member, () =>
          text(db, "select installations::text as value from github_connections", []),
        ),
      ).toBeNull();
      await expect(
        asUser(db, people.owner, () =>
          db.query("select public.save_github_connection($1, $2, null, decode($3, 'hex'), null, $4::jsonb)", [
            583231,
            "octocat",
            "0d",
            "{}",
          ]),
        ),
      ).rejects.toThrow(/github_connections_installations_chk/);
    });
  });

  test.each(["insert", "update"] as const)(
    "authenticated model %s is denied while provider writes remain allowed",
    async (operation) => {
      await withDb(async (db) => {
        const people = await fixture(db);
        const key = Buffer.alloc(32, 21).toString("base64");
        const original = await encryptSecret("synthetic-original", key);
        const replacement = await encryptSecret("synthetic-replacement", key);
        for (const { scope, owner, actor } of [
          { scope: "user", owner: people.owner, actor: people.owner },
          { scope: "org", owner: people.org, actor: people.admin },
        ]) {
          for (const kind of ["anthropic", "openai", "claude_oauth", "codex_auth"]) {
            const [id] = await asRole(db, "service_role", () =>
              ids(
                db,
                "insert into credentials(scope,owner_id,kind,value_enc) values($1::credential_scope,$2,$3::credential_kind,$4::bytea) returning id",
                [scope, owner, kind, original],
              ),
            );
            if (!id) throw Error("Service model insert failed.");
            if (operation === "insert") {
              await expect(
                asUser(db, actor, () =>
                  ids(
                    db,
                    "insert into credentials(scope,owner_id,kind,value_enc) values($1::credential_scope,$2,$3::credential_kind,$4::bytea) returning id",
                    [scope, owner, kind, replacement],
                  ),
                ),
              ).rejects.toThrow(/row-level security/);
            } else {
              expect(
                await asUser(db, actor, () =>
                  ids(db, "update credentials set value_enc=$2::bytea where id=$1 returning id", [id, replacement]),
                ),
              ).toEqual([]);
            }
            expect(await ciphertext(db, id)).toBe(Buffer.from(original).toString("hex"));
          }
          for (const kind of scope === "org" ? ["modal"] : ["boat", "modal"]) {
            const insert = () =>
              ids(
                db,
                "insert into credentials(scope,owner_id,kind,value_enc) values($1::credential_scope,$2,$3::credential_kind,$4::bytea) returning id",
                [scope, owner, kind, original],
              );
            const [id] =
              operation === "insert" ? await asUser(db, actor, insert) : await asRole(db, "service_role", insert);
            if (!id) throw Error("Provider insert failed.");
            if (operation === "update")
              expect(
                await asUser(db, actor, () =>
                  ids(db, "update credentials set value_enc=$2::bytea where id=$1 returning id", [id, replacement]),
                ),
              ).toEqual([id]);
            expect(await ciphertext(db, id)).toBe(
              Buffer.from(operation === "insert" ? original : replacement).toString("hex"),
            );
          }
        }
      });
    },
  );

  test("only the owner sees a user credential or a token", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const credential = await asRole(db, "service_role", async () => {
        const result = await db.query<{ id: string }>(
          `insert into credentials (scope, owner_id, kind, value_enc)
           values ('user', $1, 'anthropic', decode('0d', 'hex'))
           returning id`,
          [people.owner],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("user credential insert returned no id");
        return id;
      });
      expect(
        await asUser(db, people.owner, () =>
          text(db, "select kind::text as value from credentials where id = $1", [credential]),
        ),
      ).toBe("anthropic");
      expect(
        await asUser(db, people.admin, () => ids(db, "select id from credentials where id = $1", [credential])),
      ).toEqual([]);
      expect(
        await asUser(db, people.member, () => ids(db, "select id from credentials where id = $1", [credential])),
      ).toEqual([]);

      expect(
        await asUser(db, people.owner, () => ids(db, "delete from credentials where id=$1 returning id", [credential])),
      ).toEqual([]);
      expect(await text(db, "select kind::text as value from credentials where id=$1", [credential])).toBe("anthropic");
      const serviceToken = await asUser(db, people.owner, () =>
        insertToken(db, "service_tokens", people.owner, people.org, HASH),
      );
      await expect(
        asUser(db, people.owner, () => insertToken(db, "mcp_tokens", people.owner, people.org, "cd".repeat(32))),
      ).rejects.toThrow(/permission denied/);
      const mcpToken = await asRole(db, "service_role", () =>
        insertToken(db, "mcp_tokens", people.owner, people.org, "cd".repeat(32)),
      );
      expect(
        await asUser(db, people.owner, () => ids(db, "select id from service_tokens where id = $1", [serviceToken])),
      ).toEqual([serviceToken]);
      expect(
        await asUser(db, people.owner, () => ids(db, "select id from mcp_tokens where id = $1", [mcpToken])),
      ).toEqual([mcpToken]);
      expect(
        await asUser(db, people.admin, () => ids(db, "select id from service_tokens where id = $1", [serviceToken])),
      ).toEqual([]);
      expect(
        await asUser(db, people.member, () => ids(db, "select id from mcp_tokens where id = $1", [mcpToken])),
      ).toEqual([]);

      // The hash is a lookup key for the server: a user JWT mints and lists tokens, and cannot read,
      // filter or star its way to one.
      for (const table of ["service_tokens", "mcp_tokens"]) {
        for (const query of [
          `select hash from ${table}`,
          `select * from ${table}`,
          `select id from ${table} where hash = '${HASH}'`,
          `select id from ${table} order by hash`,
          `select t.hash from ${table} t`,
          `select to_jsonb(t) from ${table} t where t.hash is not null`,
        ]) {
          await expect(asUser(db, people.owner, () => db.query(query))).rejects.toThrow(
            new RegExp(`permission denied for table ${table}`),
          );
        }
      }
      expect(
        await asUser(db, people.owner, () =>
          db.query("select id, user_id, org_id, label, revoked_at, created_at from service_tokens"),
        ),
      ).toMatchObject({ rows: [{ id: serviceToken, label: "worker" }] });
      expect(
        await asRole(db, "service_role", () =>
          text(db, "select hash as value from mcp_tokens where id = $1", [mcpToken]),
        ),
      ).toBe("cd".repeat(32));

      await asUser(db, people.owner, () =>
        db.query("update service_tokens set revoked_at = now() where id = $1", [serviceToken]),
      );
      expect(
        await asUser(db, people.owner, () =>
          text(db, "select revoked_at::text as value from service_tokens where id = $1", [serviceToken]),
        ),
      ).not.toBeNull();
      await asUser(db, people.admin, () =>
        db.query("update service_tokens set revoked_at = null where id = $1", [serviceToken]),
      );
      expect(
        await asUser(db, people.owner, () =>
          text(db, "select revoked_at::text as value from service_tokens where id = $1", [serviceToken]),
        ),
      ).not.toBeNull();
    });
  });

  test("an org keeps at least one admin", async () => {
    await withDb(async (db) => {
      const people = await fixture(db);
      const second = crypto.randomUUID();
      await db.query("insert into auth.users (id) values ($1)", [second]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [people.org, second]);

      await db.query("update members set role = 'member' where org_id = $1 and user_id = $2", [people.org, second]);
      expect(await text(db, "select role::text as value from members where user_id = $1", [people.admin])).toBe(
        "admin",
      );
      expect(await text(db, "select role::text as value from members where user_id = $1", [second])).toBe("member");

      await expect(
        db.query("update members set role = 'member' where org_id = $1 and user_id = $2", [people.org, people.admin]),
      ).rejects.toThrow(/at least one admin/);
      await expect(
        db.query("delete from members where org_id = $1 and user_id = $2", [people.org, people.admin]),
      ).rejects.toThrow(/at least one admin/);
      expect(await text(db, "select role::text as value from members where user_id = $1", [people.admin])).toBe(
        "admin",
      );
    });
  });

  test("an org Boat key lives only in its org's column, and duplicate rows reconcile without losing the active key", async () => {
    const db = await openDatabase();
    try {
      const reconcile = "20261110110200_org_boat_credential_canonical.sql";
      const files = readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      await db.exec(await Bun.file(new URL("../../../scripts/db/supabase-prereq.sql", import.meta.url)).text());
      for (const file of files.filter((name) => name < reconcile))
        await db.exec(await Bun.file(`${migrationsDir}/${file}`).text());
      const [both, rowOnly, user] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      await db.query("insert into auth.users (id) values ($1)", [user]);
      await db.query("insert into orgs (id, name, boat_api_key_enc) values ($1, 'Both', '\\x0a'), ($2, 'Row', null)", [
        both,
        rowOnly,
      ]);
      await db.query(
        `insert into credentials (scope, owner_id, kind, value_enc) values
          ('org', $1, 'boat', '\\x0b'), ('org', $2, 'boat', '\\x0c'), ('org', $2, 'modal', '\\x0d'),
          ('user', $3, 'boat', '\\x0e')`,
        [both, rowOnly, user],
      );

      for (const file of files.filter((name) => name >= reconcile))
        await db.exec(await Bun.file(`${migrationsDir}/${file}`).text());

      const columns = await db.query<{ name: string; hex: string }>(
        "select name, encode(boat_api_key_enc, 'hex') as hex from orgs order by name",
      );
      expect(columns.rows).toEqual([
        { name: "Both", hex: "0a" },
        { name: "Row", hex: "0c" },
      ]);
      const rows = await db.query<{ scope: string; kind: string; hex: string }>(
        "select scope::text, kind::text, encode(value_enc, 'hex') as hex from credentials order by hex",
      );
      expect(rows.rows).toEqual([
        { scope: "org", kind: "modal", hex: "0d" },
        { scope: "user", kind: "boat", hex: "0e" },
      ]);
      await expect(
        db.query("insert into credentials (scope, owner_id, kind, value_enc) values ('org', $1, 'boat', '\\x0f')", [
          rowOnly,
        ]),
      ).rejects.toThrow(/credentials_org_boat_chk/);
    } finally {
      await db.close();
    }
  });
});

async function withDb(run: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await run(db);
  } finally {
    await db.close();
  }
}

async function fixture(db: PGlite): Promise<Fixture> {
  const row: Fixture = {
    org: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    outsider: crypto.randomUUID(),
  };
  for (const user of [row.owner, row.member, row.admin, row.outsider]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
  }
  await db.query("insert into orgs (id, name) values ($1, 'Example Org')", [row.org]);
  await db.query(
    `insert into members (org_id, user_id, role) values
      ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'admin')`,
    [row.org, row.owner, row.member, row.admin],
  );
  return row;
}

async function insertGolden(
  db: PGlite,
  people: Fixture,
  input: { name: string; visibility: Visibility; owner: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into goldens (org_id, name, visibility, owner_id, config)
     values ($1, $2, $3::public.visibility, $4, $5::jsonb)
     returning id`,
    [people.org, input.name, input.visibility, input.owner, JSON.stringify(PLAIN_CONFIG)],
  );
  const golden = result.rows[0]?.id;
  if (!golden) throw new Error("golden insert returned no id");
  return golden;
}

async function insertSandbox(db: PGlite, people: Fixture, golden: string, owner: string): Promise<string> {
  const sandbox = crypto.randomUUID();
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status)
     values ($1, $2, $3, $4, $5, 'claude', 'ready')`,
    [sandbox, `bx_${sandbox}`, golden, people.org, owner],
  );
  return sandbox;
}

async function insertToken(
  db: PGlite,
  table: "service_tokens" | "mcp_tokens",
  user: string,
  org: string,
  hash: string,
) {
  const result = await db.query<{ id: string }>(
    `insert into ${table} (user_id, org_id, hash, label) values ($1, $2, $3, 'worker') returning id`,
    [user, org, hash],
  );
  const token = result.rows[0]?.id;
  if (!token) throw new Error("token insert returned no id");
  return token;
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

async function asRole<T>(db: PGlite, role: "service_role", run: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    const value = await run();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function ids(db: PGlite, sql: string, params: unknown[] = []): Promise<string[]> {
  const result = await db.query<{ id: string }>(sql, params);
  return result.rows.map((row) => row.id);
}

async function text(db: PGlite, sql: string, params: unknown[]): Promise<string | null> {
  const result = await db.query<{ value: string | null }>(sql, params);
  return result.rows[0]?.value ?? null;
}

async function ciphertext(db: PGlite, credential: string): Promise<string | null> {
  const result = await db.query<{ hex: string | null }>(
    "select encode(value_enc, 'hex') as hex from credentials where id = $1",
    [credential],
  );
  return result.rows[0]?.hex ?? null;
}

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
