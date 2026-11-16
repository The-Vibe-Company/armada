import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { migrationsDir, openDatabase } from "../../../scripts/db/apply.ts";
import { resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";
import { createSqlVaultStore } from "../src/vault-store.ts";

const key = Buffer.alloc(32, 13).toString("base64");
test("ambiguous personal accounts never select an arbitrary row or fall back to org billing", async () => {
  const sealed = await encryptSecret("personal-account", key);
  let orgReads = 0;
  const reader = {
    credentials: async (scope: string) => {
      if (scope === "org") orgReads++;
      return ["one", "two"].map((id) => ({
        id,
        kind: "openai" as const,
        valueEnc: sealed,
        version: 1,
        status: "active",
        isDefault: false,
      }));
    },
    orgBoatKey: async () => null,
  };
  await expect(resolveCredentials(reader, key, { userId: "user", orgId: "org", harness: "codex" })).rejects.toThrow(
    /Multiple compatible accounts/,
  );
  expect(orgReads).toBe(0);
});

describe("named-account upgrade", () => {
  const migration = "20261110120200_named_model_credentials.sql";
  let connection: Awaited<ReturnType<typeof openDatabase>> | undefined;
  beforeAll(async () => {
    const db = await openDatabase();
    connection = db;
    await db.exec(await Bun.file(new URL("../../../scripts/db/supabase-prereq.sql", import.meta.url)).text());
    for (const file of (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql") && file < migration)
      .sort()) {
      await db.exec(await Bun.file(`${migrationsDir}/${file}`).text());
    }
  });
  afterAll(async () => {
    const db = connection;
    connection = undefined;
    await db?.close();
  });

  test("migration preserves historical harness kind preference and account identity", async () => {
    const db = connection;
    if (!db) throw new Error("Missing named-account schema fixture");
    const user = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    const ids = new Map<string, string>();
    for (const kind of ["anthropic", "codex_auth", "claude_oauth", "openai"]) {
      const row = await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,$2::credential_kind,$3::bytea) returning id",
        [user, kind, await encryptSecret(kind === "codex_auth" ? '{"token":"test"}' : kind, key)],
      );
      ids.set(kind, row.rows[0]?.id ?? "");
    }
    await db.exec(await Bun.file(`${migrationsDir}/${migration}`).text());
    // This fixture stops at the named-account migration, before personal agent defaults exist.
    const { agentDefaults: _agentDefaults, ...reader } = createSqlVaultStore(db);
    for (const [harness, preferred, env] of [
      ["claude", "claude_oauth", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["codex", "openai", "OPENAI_API_KEY"],
    ] as const) {
      const resolved = await resolveCredentials(reader, key, { userId: user, orgId: crypto.randomUUID(), harness });
      expect(resolved.env).toEqual({ [env]: preferred });
      expect(resolved.binding).toEqual({ credentialId: ids.get(preferred) ?? "", credentialVersion: 1 });
    }
  });
});

test("an explicitly empty account ID never falls back to a usable default", async () => {
  const valueEnc = await encryptSecret("default-account", key);
  const reader = {
    credentials: async () => [
      { id: crypto.randomUUID(), kind: "openai" as const, valueEnc, isDefault: true, status: "active", version: 1 },
    ],
    orgBoatKey: async () => null,
  };
  await expect(
    resolveCredentials(reader, key, { userId: "user", orgId: "org", harness: "codex", credentialId: "" }),
  ).rejects.toThrow();
});
