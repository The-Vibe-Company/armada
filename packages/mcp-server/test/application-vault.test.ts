import { describe, expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import { createApplicationVault, createSqlVaultStore, decryptSecret, type Sql } from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createArmadaServer } from "../src/tools.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
// Synthetic canaries, never real credentials.
const CANARY = "synthetic-vault-canary\nsecond line 🦊";

/** Check actual string leaves and JSON text fields, not a reserialized multiline string. */
function expectNoCanary(output: unknown, canary = CANARY): void {
  if (typeof output === "string") {
    expect(output).not.toContain(canary);
    const escaped = JSON.stringify(canary).slice(1, -1);
    if (escaped !== canary) expect(output).not.toContain(escaped);
  } else if (output !== null && typeof output === "object") {
    for (const value of Object.values(output)) expectNoCanary(value, canary);
  }
}

async function fixture() {
  const db = await openDatabase();
  await applyMigrations(db);
  const owner = crypto.randomUUID(),
    peer = crypto.randomUUID(),
    admin = crypto.randomUUID();
  const org = crypto.randomUUID(),
    other = crypto.randomUUID();
  for (const user of [owner, peer, admin]) await db.query("insert into auth.users(id) values($1)", [user]);
  await db.query("insert into orgs(id,name) values($1,'Vault'),($2,'Other')", [org, other]);
  await db.query(
    "insert into members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'member'),($1,$4,'admin'),($5,$3,'admin')",
    [org, owner, peer, admin, other],
  );
  const sql: Sql = {
    query: (text, params) => db.query(text, params),
    transaction: (work) => db.transaction((tx) => work(tx)),
  };
  const vault = createApplicationVault(sql, KEY);
  const options: ControlOptions = {
    applicationVault: vault,
    store: createSqlVaultStore(sql),
    authStore: createSqlAuthStore(sql),
    encryptionKey: KEY,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "synthetic-anon",
      fetch: async (_input, init) => {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        const sub = JSON.parse(atob(token.split(".")[1] ?? "")).sub;
        return Response.json({ id: sub });
      },
    },
  };
  const actor = (userId: string, orgId = org) => ({
    userId,
    orgs: [{ orgId, role: userId === admin ? ("admin" as const) : ("member" as const) }],
    via: "supabase" as const,
  });
  async function api(user: string, route: string, body: unknown, query = "") {
    const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`;
    const result = await handleControlRequest(
      new Request(`https://armada.test/api/v1/${route}${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      }),
      options,
    );
    if (!result) throw new Error("missing response");
    const text = await result.text();
    return { status: result.status, text, body: JSON.parse(text), headers: result.headers };
  }
  async function mcp(user: string) {
    const logs: string[] = [];
    const server = createArmadaServer(
      {
        applicationVault: vault,
        caller: actor(user),
        data: createSqlData(sql)(actor(user)),
        launchCredentials: {
          resolve: async () => {
            throw new Error("no launch");
          },
        },
        exposedSecrets: async () => [],
        provider: async () => {
          throw new Error("no provider");
        },
        now: () => new Date(),
        sleep: async () => {},
        logError: (line) => logs.push(line),
      },
      "test",
    );
    const client = new Client({ name: "vault-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    return {
      client,
      logs,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  return { db, sql, vault, options, owner, peer, admin, org, other, api, mcp, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withVault(work: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try {
    await work(f);
  } finally {
    await f.db.close();
  }
}

describe("application vault control API and MCP", () => {
  test("write-only secret lifecycle seals values, CAS-fences rotation/revocation, tombstones deletion and audits only IDs", async () => {
    await withVault(async (f) => {
      expect(() => expectNoCanary({ item: { value: CANARY } })).toThrow();
      expect(() => expectNoCanary({ content: [{ text: JSON.stringify({ value: CANARY }) }] })).toThrow();
      const created = await f.api(f.owner, "secrets/set", {
        org: f.org,
        scope: "personal",
        name: "APP_TOKEN",
        value: CANARY,
      });
      expect(created.status).toBe(200);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const { id } = created.body.item;
      const stored = (
        await f.db.query<{ value_enc: Uint8Array }>("select value_enc from application_secrets where id=$1", [id])
      ).rows[0];
      expect(stored?.value_enc).not.toEqual(Buffer.from(CANARY));
      expect(await decryptSecret(stored?.value_enc as Uint8Array<ArrayBuffer>, KEY)).toBe(CANARY);
      const rotations = await Promise.all(
        [1, 2].map(() =>
          f.api(f.owner, "secrets/rotate", {
            org: f.org,
            id,
            expectedVersion: 1,
            value: "replacement synthetic canary",
          }),
        ),
      );
      expect(rotations.map((r) => r.status).sort()).toEqual([200, 409]);
      const first = rotations.find((r) => r.status === 200);
      expect(first?.body.item).toMatchObject({ version: 2, epoch: 2 });
      const revoked = await f.api(f.owner, "secrets/revoke", { org: f.org, id, expectedVersion: 2 });
      expect(revoked.body.item).toMatchObject({ status: "revoked", version: 3, epoch: 3 });
      expect(
        (await f.api(f.owner, "secrets/rotate", { org: f.org, id, expectedVersion: 3, value: CANARY })).status,
      ).toBe(409);
      const deleted = await f.api(f.owner, "secrets/delete", { org: f.org, id, expectedVersion: 3 });
      expect(deleted.body.item).toMatchObject({ status: "deleted", version: 4, epoch: 4 });
      expect((await f.api(f.owner, "secrets/delete", { org: f.org, id, expectedVersion: 4 })).body).toEqual(
        deleted.body,
      );
      expect((await f.db.query("select value_enc from application_secrets where id=$1", [id])).rows).toEqual([
        { value_enc: null },
      ]);
      const audit = (
        await f.db.query<{ operation: string }>("select * from application_vault_audit order by created_at,id")
      ).rows;
      expect(audit).toHaveLength(4);
      expect(audit.map((row) => row.operation)).toEqual(["set", "rotate", "revoke", "delete"]);
      const outputs = [
        created,
        first,
        revoked,
        deleted,
        audit,
        await f.api(f.owner, "secrets/list", { org: f.org }),
        await f.api(f.owner, "secrets/read", { org: f.org, id }),
      ];
      expectNoCanary(outputs);
      expectNoCanary(outputs, "replacement synthetic canary");
      const recreated = await f.api(f.owner, "secrets/set", {
        org: f.org,
        scope: "personal",
        name: "APP_TOKEN",
        value: CANARY,
      });
      expect(recreated.body.item.id).not.toBe(id);
    });
  });

  test("readable variable values are explicit; org management requires current admin and personal entries remain owner-only", async () => {
    await withVault(async (f) => {
      const variable = await f.api(f.owner, "variables/set", {
        org: f.org,
        scope: "personal",
        name: "APP_REGION",
        value: "  eu\n",
      });
      const id = variable.body.item.id;
      expect(variable.text).not.toContain("  eu");
      expect((await f.api(f.owner, "variables/read", { org: f.org, id })).body.value).toBe("  eu\n");
      for (const user of [f.peer, f.admin]) {
        expect((await f.api(user, "variables/read", { org: f.org, id })).status).toBe(404);
        expect(
          (await f.api(user, "variables/update", { org: f.org, id, expectedVersion: 1, value: "us" })).status,
        ).toBe(404);
        expect((await f.api(user, "variables/list", { org: f.org })).body.items).toEqual([]);
      }
      expect(
        (await f.api(f.owner, "variables/update", { org: f.org, id, expectedVersion: 1, value: "" })).body.item.version,
      ).toBe(2);
      expect((await f.api(f.owner, "variables/read", { org: f.org, id })).body.value).toBe("");
      const shared = await f.api(f.admin, "secrets/set", {
        org: f.org,
        scope: "org",
        name: "SHARED_TOKEN",
        value: CANARY,
      });
      for (const user of [f.owner, f.peer]) {
        expect((await f.api(user, "secrets/list", { org: f.org })).body.items).toHaveLength(1);
        expect(
          (await f.api(user, "secrets/revoke", { org: f.org, id: shared.body.item.id, expectedVersion: 1 })).status,
        ).toBe(403);
        expect(
          (await f.api(user, "secrets/set", { org: f.org, scope: "org", name: "DENIED_TOKEN", value: CANARY })).status,
        ).toBe(403);
      }
      expect((await f.api(f.owner, "secrets/list", { org: f.other })).status).toBe(403);
      await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.org, f.owner]);
      await expect(f.vault.command(f.actor(f.owner), "variable", "read", { org: f.org, id })).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });

  test("MCP consumes API uploads only once, bound to actor/org/expiry/version, and never accepts plaintext writes", async () => {
    await withVault(async (f) => {
      const owner = await f.mcp(f.owner),
        peer = await f.mcp(f.peer);
      try {
        const upload = await f.api(f.owner, "secrets/upload", {
          org: f.org,
          operation: "set",
          scope: "personal",
          name: "UPLOADED_TOKEN",
          value: CANARY,
        });
        expect(upload.status).toBe(200);
        const ref = upload.body.uploadReference;
        const uploadRow = (
          await f.db.query<{ hash: string; value_enc: Uint8Array }>(
            "select hash,value_enc from application_secret_uploads",
          )
        ).rows[0];
        expect(uploadRow?.hash).not.toBe(ref);
        expect(await decryptSecret(uploadRow?.value_enc as Uint8Array<ArrayBuffer>, KEY)).toBe(CANARY);
        const args = { org: f.org, uploadReference: ref };
        expect((await peer.client.callTool({ name: "secret_commit", arguments: args })).isError).toBe(true);
        const committed = await owner.client.callTool({ name: "secret_commit", arguments: args });
        expect(committed.isError).not.toBe(true);
        expectNoCanary(committed);
        const id = (committed.structuredContent as { item: { id: string } }).item.id;
        expect((await owner.client.callTool({ name: "secret_commit", arguments: args })).isError).toBe(true);
        const replacement = await f.api(f.owner, "secrets/upload", {
          org: f.org,
          operation: "rotate",
          id,
          expectedVersion: 1,
          value: "synthetic replacement",
        });
        const rotated = await owner.client.callTool({
          name: "secret_commit",
          arguments: { org: f.org, uploadReference: replacement.body.uploadReference },
        });
        expect(rotated.isError).not.toBe(true);
        expect(rotated.structuredContent).toMatchObject({ item: { id, version: 2, epoch: 2 } });
        expectNoCanary(rotated, "synthetic replacement");
        const rotate = await f.api(f.owner, "secrets/upload", {
          org: f.org,
          operation: "rotate",
          id,
          expectedVersion: 2,
          value: "replacement",
        });
        await f.api(f.owner, "secrets/revoke", { org: f.org, id, expectedVersion: 2 });
        expect(
          (
            await owner.client.callTool({
              name: "secret_commit",
              arguments: { org: f.org, uploadReference: rotate.body.uploadReference },
            })
          ).isError,
        ).toBe(true);
        const expired = await f.api(f.owner, "secrets/upload", {
          org: f.org,
          operation: "set",
          scope: "personal",
          name: "EXPIRED_TOKEN",
          value: CANARY,
        });
        await f.db.query("update application_secret_uploads set expires_at=now()-interval '1 second'");
        expect(
          (
            await owner.client.callTool({
              name: "secret_commit",
              arguments: { org: f.org, uploadReference: expired.body.uploadReference },
            })
          ).isError,
        ).toBe(true);
        await f.db.query("update application_vault_audit set created_at=now()-interval '91 days'");
        await f.vault.purgeExpired();
        expect((await f.db.query("select hash from application_secret_uploads")).rows).toEqual([]);
        expect((await f.db.query("select id from application_vault_audit")).rows).toEqual([]);
        expect((await f.db.query("select status from application_secrets where id=$1", [id])).rows).toEqual([
          { status: "revoked" },
        ]);
        const list = await owner.client.listTools();
        expect(list.tools.some((t) => ["secret_set", "secret_rotate", "secret_read"].includes(t.name))).toBe(false);
        const rejected = await owner.client.callTool({
          name: "secret_commit",
          arguments: { org: f.org, uploadReference: ref, value: CANARY },
        });
        expect(rejected.isError).toBe(true);
        expectNoCanary(rejected);
        expect(owner.logs).toEqual([]);
        expect(peer.logs).toEqual([]);
        const readable = await owner.client.callTool({
          name: "variable_set",
          arguments: { org: f.org, scope: "personal", name: "REGION", value: "eu" },
        });
        expect(readable.isError).not.toBe(true);
        expect(
          (
            await owner.client.callTool({
              name: "variable_read",
              arguments: { org: f.org, id: (readable.structuredContent as { item: { id: string } }).item.id },
            })
          ).structuredContent,
        ).toMatchObject({ value: "eu" });
      } finally {
        await owner.close();
        await peer.close();
      }
    });
  });

  test("validation and backend failures never echo inputs; values are UTF-8 bounded, reserved keys denied and body-only", async () => {
    await withVault(async (f) => {
      for (const [name, value] of [
        ["ARMADA_TOKEN", CANARY],
        ["BOAT_KEY", CANARY],
        ["MODAL_TOKEN", CANARY],
        ["ANTHROPIC_API_KEY", CANARY],
        ["OPENAI_API_KEY", CANARY],
        ["CLAUDE_CODE_OAUTH_TOKEN", CANARY],
        ["CODEX_HOME", CANARY],
        ["GH_TOKEN", CANARY],
        ["GITHUB_TOKEN", CANARY],
        ["MCP_TOKEN", CANARY],
        ["PATH", CANARY],
        ["HOME", CANARY],
        ["SHELL", CANARY],
        ["ENV", CANARY],
        ["BASH_ENV", CANARY],
        ["LD_PRELOAD", CANARY],
        ["DYLD_INSERT_LIBRARIES", CANARY],
        ["NODE_OPTIONS", CANARY],
        ["PYTHONPATH", CANARY],
        ["SSL_CERT_FILE", CANARY],
        ["HTTP_PROXY", CANARY],
        ["HTTPS_PROXY", CANARY],
        ["ALL_PROXY", CANARY],
        ["NO_PROXY", CANARY],
        ["NEXT_PUBLIC_TOKEN", CANARY],
        ["VITE_TOKEN", CANARY],
        ["PUBLIC_TOKEN", CANARY],
        ["lower_case", CANARY],
        ["VALID_TOKEN", ""],
        ["VALID_TOKEN", "a\0b"],
        ["VALID_TOKEN", "\ud800"],
        ["VALID_TOKEN", "🦊".repeat(2049)],
      ]) {
        const r = await f.api(f.owner, "secrets/set", { org: f.org, scope: "personal", name, value });
        expect(r.status).toBe(400);
        expectNoCanary(r.text);
      }
      expect(
        (
          await f.api(f.owner, "variables/set", {
            org: f.org,
            scope: "personal",
            name: "NEXT_PUBLIC_OK",
            value: "🦊".repeat(2048),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.api(
            f.owner,
            "secrets/set",
            { org: f.org, scope: "personal", name: "BODY_ONLY", value: CANARY },
            "?value=synthetic",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(f.owner, "secrets/set", {
            org: f.org,
            scope: "personal",
            name: "UNKNOWN",
            value: CANARY,
            unknown: CANARY,
          })
        ).status,
      ).toBe(400);

      for (const route of ["secrets/toString", "secrets/__proto__", "secrets/set/ignored"]) {
        expect((await f.api(f.owner, route, { org: f.org })).status).toBe(400);
      }
      const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: f.owner })).replace(/=+$/, "")}.sig`;
      for (const body of [new Uint8Array([0xff]), new Uint8Array(65537).fill(32)]) {
        const response = await handleControlRequest(
          new Request("https://armada.test/api/v1/secrets/set", {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}` },
            body,
          }),
          f.options,
        );
        expect(response?.status).toBe(400);
        expectNoCanary(await response?.text());
      }
      const duplicate = { org: f.org, scope: "personal", name: "DUPLICATE", value: CANARY };
      expect((await f.api(f.owner, "secrets/set", duplicate)).status).toBe(200);
      const r = await f.api(f.owner, "secrets/set", duplicate);
      expect(r.status).toBe(409);
      expectNoCanary(r.text);
      await f.db.exec(
        "create function reject_vault_write() returns trigger language plpgsql as $$ begin raise exception 'synthetic-vault-canary'; end $$; create trigger reject_vault_write before insert on application_vault_audit for each row execute function reject_vault_write();",
      );
      const failure = await f.api(f.owner, "secrets/set", { ...duplicate, name: "BACKEND" });
      expect(failure.status).toBe(503);
      expectNoCanary(failure.text, "synthetic-vault-canary");
      expect((await f.db.query("select id from application_secrets where name='BACKEND'")).rows).toEqual([]);
      const upload = await f.api(f.owner, "secrets/upload", {
        org: f.org,
        operation: "set",
        scope: "personal",
        name: "APP_BACKEND",
        value: CANARY,
      });
      expect(upload.status).toBe(200);
      const mcp = await f.mcp(f.owner);
      try {
        const rejected = await mcp.client.callTool({
          name: "secret_commit",
          arguments: { org: f.org, uploadReference: upload.body.uploadReference },
        });
        expect(rejected.isError).toBe(true);
        expectNoCanary(rejected, "synthetic-vault-canary");
        expect(mcp.logs).toEqual([]);
        expect((await f.db.query("select id from application_secrets where name='APP_BACKEND'")).rows).toEqual([]);
        expect((await f.db.query("select hash from application_secret_uploads")).rows).toHaveLength(1);
      } finally {
        await mcp.close();
      }
    });
  });

  test("real JWT RLS permits safe reads only, denies all ciphertext/upload access and direct mutations even for owner/admin", async () => {
    await withVault(async (f) => {
      const personal = await f.api(f.owner, "secrets/set", {
        org: f.org,
        scope: "personal",
        name: "PRIVATE",
        value: CANARY,
      });
      await f.api(f.admin, "secrets/set", { org: f.org, scope: "org", name: "SHARED", value: CANARY });
      await f.api(f.owner, "variables/set", { org: f.org, scope: "personal", name: "PRIVATE_VAR", value: "readable" });
      await f.api(f.admin, "variables/set", { org: f.org, scope: "org", name: "SHARED_VAR", value: "readable" });
      for (const user of [f.owner, f.peer, f.admin]) {
        await f.db.exec("set role authenticated");
        await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
        const rows = (await f.db.query<{ id: string }>("select id from application_secrets order by name")).rows;
        expect(rows.some((r) => r.id === personal.body.item.id)).toBe(user === f.owner);
        const variables = (await f.db.query<{ name: string }>("select name,value from readable_variables")).rows;
        expect(variables.map((v) => v.name).sort()).toEqual(
          user === f.owner ? ["PRIVATE_VAR", "SHARED_VAR"] : ["SHARED_VAR"],
        );
        for (const query of [
          "update readable_variables set value='unauthorized'",
          "delete from readable_variables",
          "select value_enc from application_secrets",
          "select * from application_secrets",
          "select * from application_secret_uploads",
          "update application_secrets set status='deleted'",
          "delete from application_secrets",
          "update application_vault_audit set outcome='succeeded'",
        ]) {
          await expect(f.db.query(query)).rejects.toThrow("permission denied");
        }
        const audit = (await f.db.query("select resource_id from application_vault_audit")).rows;
        expect(audit).toHaveLength(user === f.peer ? 0 : 2);
        await f.db.exec("reset role");
      }
      await f.db.exec("set role anon");
      await expect(f.db.query("select id from application_secrets")).rejects.toThrow("permission denied");
      await f.db.exec("reset role");
    });
  });
});
