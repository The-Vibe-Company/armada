import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import {
  addMember,
  createOrg,
  createSqlVaultStore,
  listCredentials,
  listMembers,
  listOrgs,
  parseCredentialKind,
  parseCredentialValue,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveCredentials,
  setCredential,
  setMemberRole,
  VaultError,
  type VaultStore,
} from "../src/index.ts";

const KEY = Buffer.alloc(32, 9).toString("base64");
const CLAUDE = "sk-ant-oat01-user-token";
const ORG_CLAUDE = "sk-ant-oat01-org-token";
const AUTH_JSON = '{"OPENAI_API_KEY":null,"tokens":{"access_token":"at-secret"}}';

describe("orgs and members", () => {
  test("the creator is the first admin, and org names are unique ignoring case", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "  Vibe  ");
      expect(org).toMatchObject({ name: "Vibe", role: "admin" });
      expect(await listOrgs(store, people.stan)).toEqual([org]);
      expect(await listOrgs(store, people.ada)).toEqual([]);
      await expect(createOrg(store, people.ada, "vibe")).rejects.toThrow(/already exists/);
      await expect(createOrg(store, people.ada, "   ")).rejects.toThrow(/1 to 120/);
    });
  });

  test("an admin adds, promotes and removes members; a member can do none of it", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      const added = await addMember(store, people.stan, { org: "Vibe", email: "ADA@example.com", role: "member" });
      expect(added).toMatchObject({ userId: people.ada, email: "ada@example.com", role: "member" });
      await expect(
        addMember(store, people.stan, { org: org.id, email: "ada@example.com", role: "member" }),
      ).rejects.toThrow(/already a member/);
      await expect(
        addMember(store, people.stan, { org: org.id, email: "nobody@example.com", role: "member" }),
      ).rejects.toThrow(/armada login/);

      const asMember = { org: undefined, email: "bob@example.com" };
      await expect(addMember(store, people.ada, { ...asMember, role: "member" })).rejects.toThrow(/Only an org admin/);
      await expect(setMemberRole(store, people.ada, { ...asMember, role: "admin" })).rejects.toThrow(
        /Only an org admin/,
      );
      await expect(removeMember(store, people.ada, { org: undefined, email: "stan@example.com" })).rejects.toThrow(
        /Only an org admin/,
      );

      await setMemberRole(store, people.stan, { org: undefined, email: "ada@example.com", role: "admin" });
      const listed = await listMembers(store, people.ada, "vibe");
      expect(listed.members.map((member) => [member.email, member.role])).toEqual([
        ["stan@example.com", "admin"],
        ["ada@example.com", "admin"],
      ]);
      await removeMember(store, people.stan, { org: undefined, email: "ada@example.com" });
      expect((await listMembers(store, people.stan, undefined)).members).toHaveLength(1);
      await expect(removeMember(store, people.stan, { org: undefined, email: "ada@example.com" })).rejects.toThrow(
        /not a member/,
      );
    });
  });

  test("an org keeps its last admin, and an outsider learns nothing about it", async () => {
    await withVault(async ({ store, people }) => {
      await createOrg(store, people.stan, "Vibe");
      await expect(
        setMemberRole(store, people.stan, { org: undefined, email: "stan@example.com", role: "member" }),
      ).rejects.toThrow(/at least one admin/);
      await expect(removeMember(store, people.stan, { org: undefined, email: "stan@example.com" })).rejects.toThrow(
        /at least one admin/,
      );
      await expect(listMembers(store, people.ada, "Vibe")).rejects.toThrow("You are not a member of that org.");
      await expect(listMembers(store, people.ada, "Missing")).rejects.toThrow("You are not a member of that org.");
    });
  });
});

describe("credentials", () => {
  test("a credential is ciphertext in the database and comes back through the resolver", async () => {
    await withVault(async ({ db, store, people }) => {
      await createOrg(store, people.stan, "Vibe");
      await setCredential(store, KEY, people.stan, {
        scope: "user",
        org: undefined,
        kind: "claude_oauth",
        value: `${CLAUDE}\n`,
      });
      await setCredential(store, KEY, people.stan, {
        scope: "user",
        org: undefined,
        kind: "codex_auth",
        value: AUTH_JSON,
      });
      await setCredential(store, KEY, people.stan, {
        scope: "user",
        org: undefined,
        kind: "boat",
        value: "boat-personal",
      });
      await setCredential(store, KEY, people.stan, { scope: "org", org: undefined, kind: "boat", value: "boat-org" });

      const dump = await db.query<{ blob: string }>(`
        select coalesce(string_agg(encode(value_enc, 'escape'), ' '), '') as blob from credentials
        union all select coalesce(string_agg(encode(boat_api_key_enc, 'escape'), ' '), '') from orgs
      `);
      const raw = dump.rows.map((row) => row.blob).join(" ");
      for (const secret of [CLAUDE, "at-secret", "boat-personal", "boat-org"]) expect(raw).not.toContain(secret);
      const sizes = await db.query<{ n: number }>(
        "select octet_length(value_enc)::int as n from credentials order by 1",
      );
      expect(sizes.rows.every((row) => row.n > 12 + 16)).toBe(true);

      const org = (await listOrgs(store, people.stan))[0];
      expect(
        await resolveCredentials(store, KEY, { userId: people.stan, orgId: org?.id ?? "", harness: "claude" }),
      ).toEqual({
        env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE },
        files: [],
        sources: [{ kind: "claude_oauth", scope: "user" }],
      });
    });
  });

  test("the user's credential wins over the org's, per harness, and the org fills the gaps", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      await addMember(store, people.stan, { org: "Vibe", email: "ada@example.com", role: "member" });
      await setCredential(store, KEY, people.stan, {
        scope: "org",
        org: "Vibe",
        kind: "claude_oauth",
        value: ORG_CLAUDE,
      });
      await setCredential(store, KEY, people.stan, {
        scope: "org",
        org: "Vibe",
        kind: "openai",
        value: "sk-org-openai",
      });
      const ada = { userId: people.ada, orgId: org.id };

      expect((await resolveCredentials(store, KEY, { ...ada, harness: "claude" })).env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: ORG_CLAUDE,
      });
      await setCredential(store, KEY, people.ada, {
        scope: "user",
        org: undefined,
        kind: "anthropic",
        value: "sk-ant-api03-ada",
      });
      expect(await resolveCredentials(store, KEY, { ...ada, harness: "claude" })).toMatchObject({
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-ada" },
        sources: [{ kind: "anthropic", scope: "user" }],
      });
      expect((await resolveCredentials(store, KEY, { ...ada, harness: "codex" })).env).toEqual({
        OPENAI_API_KEY: "sk-org-openai",
      });

      await setCredential(store, KEY, people.ada, {
        scope: "user",
        org: undefined,
        kind: "codex_auth",
        value: AUTH_JSON,
      });
      await setCredential(store, KEY, people.ada, {
        scope: "user",
        org: undefined,
        kind: "claude_oauth",
        value: CLAUDE,
      });
      const codex = await resolveCredentials(store, KEY, { ...ada, harness: "codex" });
      expect(codex.env).toEqual({});
      expect(codex.files).toEqual([{ path: "/home/user/.codex/auth.json", content: AUTH_JSON, mode: 0o600 }]);
      expect((await resolveCredentials(store, KEY, { ...ada, harness: "claude" })).env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE,
      });
    });
  });

  test("a launch with no credential for the harness says how to add one", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      const input = { userId: people.stan, orgId: org.id };
      await expect(resolveCredentials(store, KEY, { ...input, harness: "codex" })).rejects.toThrow(
        /armada creds set openai/,
      );
      await setCredential(store, KEY, people.stan, {
        scope: "user",
        org: undefined,
        kind: "claude_oauth",
        value: CLAUDE,
      });
      await expect(resolveCredentials(store, KEY, { ...input, harness: "codex" })).rejects.toBeInstanceOf(VaultError);
      await expect(
        resolveCredentials(store, Buffer.alloc(32, 1).toString("base64"), { ...input, harness: "claude" }),
      ).rejects.toThrow("A stored credential could not be decrypted.");
    });
  });

  test("only an org admin changes org credentials, and a member lists kinds, never values", async () => {
    await withVault(async ({ store, people }) => {
      await createOrg(store, people.stan, "Vibe");
      await addMember(store, people.stan, { org: "Vibe", email: "ada@example.com", role: "member" });
      const org = { scope: "org", org: "Vibe" } as const;
      await expect(
        setCredential(store, KEY, people.ada, { ...org, kind: "claude_oauth", value: CLAUDE }),
      ).rejects.toThrow(/Only an org admin/);
      await expect(setCredential(store, KEY, people.ada, { ...org, kind: "boat", value: "boat-x" })).rejects.toThrow(
        /Only an org admin/,
      );
      await expect(removeCredential(store, people.ada, { ...org, kind: "boat" })).rejects.toThrow(/Only an org admin/);

      await setCredential(store, KEY, people.stan, { ...org, kind: "claude_oauth", value: CLAUDE });
      await setCredential(store, KEY, people.stan, { ...org, kind: "boat", value: "boat-org" });
      const seen = await listCredentials(store, people.ada, undefined);
      expect(seen.user).toEqual([]);
      expect(seen.orgs[0]?.credentials.map((item) => item.kind)).toEqual(["boat", "claude_oauth"]);
      expect(JSON.stringify(seen)).not.toContain(CLAUDE);
      expect(JSON.stringify(seen)).not.toContain("boat-org");

      await removeCredential(store, people.stan, { ...org, kind: "boat" });
      await removeCredential(store, people.stan, { ...org, kind: "claude_oauth" });
      await expect(removeCredential(store, people.stan, { ...org, kind: "boat" })).rejects.toThrow(
        /No such credential/,
      );
      expect((await listCredentials(store, people.stan, "Vibe")).orgs[0]?.credentials).toEqual([]);
    });
  });

  test("setting a credential again replaces it", async () => {
    await withVault(async ({ store, people }) => {
      await createOrg(store, people.stan, "Vibe");
      const own = { scope: "user", org: undefined, kind: "anthropic" } as const;
      await setCredential(store, KEY, people.stan, { ...own, value: "sk-ant-api03-one" });
      await setCredential(store, KEY, people.stan, { ...own, value: "sk-ant-api03-two" });
      expect((await listCredentials(store, people.stan, undefined)).user).toHaveLength(1);
      const org = (await listOrgs(store, people.stan))[0];
      const resolved = await resolveCredentials(store, KEY, {
        userId: people.stan,
        orgId: org?.id ?? "",
        harness: "claude",
      });
      expect(resolved.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-two" });
    });
  });
});

describe("boat keys", () => {
  test("a private golden uses the owner's personal key, an org golden uses the org key", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      await addMember(store, people.stan, { org: "Vibe", email: "ada@example.com", role: "member" });
      await setCredential(store, KEY, people.stan, { scope: "org", org: "Vibe", kind: "boat", value: "boat-org" });
      const ada = { userId: people.ada, orgId: org.id };

      expect(await resolveBoatKey(store, KEY, { ...ada, visibility: "private" })).toEqual({
        key: "boat-org",
        scope: "org",
      });
      await setCredential(store, KEY, people.ada, { scope: "user", org: undefined, kind: "boat", value: "boat-ada" });
      expect(await resolveBoatKey(store, KEY, { ...ada, visibility: "private" })).toEqual({
        key: "boat-ada",
        scope: "user",
      });
      expect(await resolveBoatKey(store, KEY, { ...ada, visibility: "org" })).toEqual({
        key: "boat-org",
        scope: "org",
      });
    });
  });

  test("without a key the error says who can set one", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      const input = { userId: people.stan, orgId: org.id };
      await expect(resolveBoatKey(store, KEY, { ...input, visibility: "org" })).rejects.toThrow(/org admin sets it/);
      await setCredential(store, KEY, people.stan, { scope: "user", org: undefined, kind: "boat", value: "boat-stan" });
      await expect(resolveBoatKey(store, KEY, { ...input, visibility: "org" })).rejects.toThrow(
        /org has no boat.dev key/,
      );
    });
  });
});

describe("credential values", () => {
  test("a token is trimmed and must be one word, an auth.json must be a JSON object", () => {
    expect(parseCredentialValue("claude_oauth", "  sk-ant-oat01-x\n")).toBe("sk-ant-oat01-x");
    expect(() => parseCredentialValue("openai", "")).toThrow(/empty/);
    expect(() => parseCredentialValue("openai", "sk a b")).toThrow(/no spaces/);
    expect(() => parseCredentialValue("openai", "x".repeat(9000))).toThrow(/too long/);
    expect(() => parseCredentialValue("codex_auth", "not json")).toThrow(/JSON file/);
    expect(() => parseCredentialValue("codex_auth", "[]")).toThrow(/JSON object/);
    expect(() => parseCredentialValue("codex_auth", "{}")).toThrow(/JSON object/);
    expect(parseCredentialValue("codex_auth", `\n${AUTH_JSON}\n`)).toBe(AUTH_JSON);
  });

  test("a rejected value is never echoed in the error", () => {
    try {
      parseCredentialValue("openai", "sk secret-part");
    } catch (error) {
      expect(String(error)).not.toContain("secret-part");
    }
  });

  test("kinds are named the way the CLI spells them", () => {
    expect(parseCredentialKind("claude-oauth")).toBe("claude_oauth");
    expect(parseCredentialKind("Codex-Auth")).toBe("codex_auth");
    expect(() => parseCredentialKind("opencode")).toThrow(/Unknown credential 'opencode'/);
  });
});

interface People {
  stan: string;
  ada: string;
  bob: string;
}

describe("GitHub connections", () => {
  test("a rotated refresh token replaces the one it was read with, once", async () => {
    await withVault(async ({ store, db, people }) => {
      await db.query(
        `insert into github_connections (user_id, github_id, login, refresh_token_enc)
         values ($1, 583231, 'octocat', $2::bytea)`,
        [people.stan, new Uint8Array([1, 2, 3])],
      );
      const read = await store.getGitHubConnection(people.stan);
      expect(read).toMatchObject({
        userId: people.stan,
        githubId: 583231,
        login: "octocat",
        name: null,
        revokedAt: null,
      });
      expect([...(read?.refreshTokenEnc ?? [])]).toEqual([1, 2, 3]);
      expect(await store.getGitHubConnection(people.ada)).toBeNull();

      const expiry = new Date("2027-05-10T12:00:00.000Z");
      expect(
        await store.rotateGitHubToken(people.stan, new Uint8Array([1, 2, 3]), {
          refreshTokenEnc: new Uint8Array([4, 5]),
          refreshExpiresAt: expiry,
          accessTokenEnc: new Uint8Array([6]),
          accessExpiresAt: expiry,
        }),
      ).toBe(true);
      expect(
        await store.rotateGitHubToken(people.stan, new Uint8Array([1, 2, 3]), {
          refreshTokenEnc: new Uint8Array([9]),
          refreshExpiresAt: null,
          accessTokenEnc: new Uint8Array([6]),
          accessExpiresAt: expiry,
        }),
      ).toBe(false);
      const rotated = await store.getGitHubConnection(people.stan);
      expect([...(rotated?.refreshTokenEnc ?? [])]).toEqual([4, 5]);
      expect(rotated?.refreshExpiresAt?.toISOString()).toBe(expiry.toISOString());

      await store.updateGitHubProfile(people.stan, { id: 583231, login: "octo-renamed", name: "The Octocat" });
      expect(await store.getGitHubConnection(people.stan)).toMatchObject({
        login: "octo-renamed",
        name: "The Octocat",
      });
    });
  });

  test("a revoked connection is flagged only while its token is the one GitHub refused, and is not rotated", async () => {
    await withVault(async ({ store, db, people }) => {
      await db.query(
        `insert into github_connections (user_id, github_id, login, refresh_token_enc)
         values ($1, 1, 'octocat', $2::bytea)`,
        [people.stan, new Uint8Array([1])],
      );
      expect(await store.markGitHubRevoked(people.stan, new Uint8Array([7]))).toBe(false);
      expect((await store.getGitHubConnection(people.stan))?.revokedAt).toBeNull();
      expect(await store.markGitHubRevoked(people.stan, new Uint8Array([1]))).toBe(true);
      expect((await store.getGitHubConnection(people.stan))?.revokedAt).toBeInstanceOf(Date);
      expect(
        await store.rotateGitHubToken(people.stan, new Uint8Array([1]), {
          refreshTokenEnc: new Uint8Array([2]),
          refreshExpiresAt: null,
          accessTokenEnc: new Uint8Array([6]),
          accessExpiresAt: new Date("2027-05-10T12:00:00.000Z"),
        }),
      ).toBe(false);
    });
  });
});

async function withVault(
  run: (ctx: { db: PGlite; store: VaultStore; people: People }) => Promise<void>,
): Promise<void> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    const people = { stan: crypto.randomUUID(), ada: crypto.randomUUID(), bob: crypto.randomUUID() };
    await db.query(
      "insert into auth.users (id, email) values ($1, 'stan@example.com'), ($2, 'ada@example.com'), ($3, 'bob@example.com')",
      [people.stan, people.ada, people.bob],
    );
    await run({ db, store: createSqlVaultStore(db), people });
  } finally {
    await db.close();
  }
}
