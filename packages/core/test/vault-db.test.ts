import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";
import { resolveGitHubAccess } from "../src/github.ts";
import {
  addMember,
  createOrg,
  createSqlVaultStore,
  listCredentials,
  listMembers,
  listOrgs,
  mutateCredentialAccount,
  parseCredentialKind,
  parseCredentialValue,
  removeCredential,
  removeMember,
  resolveBoatKey,
  resolveCredentials,
  resolveModalTokens,
  type Sql,
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
      ).toMatchObject({
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

describe("named model accounts", () => {
  test("legacy kind-set requires an ID when another compatible kind has duplicate accounts", async () => {
    await withVault(async ({ store, people }) => {
      for (const kind of ["openai", "anthropic"] as const) {
        for (let index = 0; index < 2; index++)
          await mutateCredentialAccount(store, KEY, people.stan, {
            action: "set",
            scope: "user",
            kind,
            value: `account-${kind}-${index}`,
          });
      }
      for (const [kind, value] of [
        ["codex_auth", AUTH_JSON],
        ["claude_oauth", CLAUDE],
      ] as const) {
        await expect(
          setCredential(store, KEY, people.stan, { scope: "user", org: undefined, kind, value }),
        ).rejects.toThrow(/Multiple accounts/);
      }
      expect((await listCredentials(store, people.stan, undefined)).user).toHaveLength(4);
    });
  });
  test("ID mutations authorize owners/admins, preserve secret revisions and pin selection across default changes", async () => {
    await withVault(async ({ store, people, db }) => {
      const org = await createOrg(store, people.stan, "Accounts");
      await addMember(store, people.stan, { org: org.id, email: "ada@example.com", role: "member" });
      // Canonical account operations, including explicit CAS, run as the real service role.
      await db.exec("set role service_role");
      expect((await db.query<{ role: string }>("select current_user as role")).rows[0]?.role).toBe("service_role");
      const create = (name: string, value: string) =>
        mutateCredentialAccount(store, KEY, people.stan, { action: "set", scope: "user", kind: "openai", name, value });
      const first = await create("Work", "work-key");
      const second = await create("Personal", "personal-key");
      expect(first.id).not.toBe(second.id);
      const actor = { userId: people.stan, orgId: org.id, harness: "codex" as const };
      await expect(resolveCredentials(store, KEY, actor)).rejects.toThrow(/Multiple compatible/);
      await mutateCredentialAccount(store, KEY, people.stan, { action: "default", scope: "user", id: first.id! });
      const pinned = (await resolveCredentials(store, KEY, actor)).binding!;
      expect(pinned).toEqual({ credentialId: first.id!, credentialVersion: 1 });
      await mutateCredentialAccount(store, KEY, people.stan, { action: "default", scope: "user", id: second.id! });
      expect((await resolveCredentials(store, KEY, { ...actor, ...pinned })).env).toEqual({
        OPENAI_API_KEY: "work-key",
      });
      const before = await db.query<{ value_enc: Uint8Array }>("select value_enc from credentials where id=$1", [
        first.id,
      ]);
      const renamed = await mutateCredentialAccount(store, KEY, people.stan, {
        action: "rename",
        scope: "user",
        id: first.id!,
        name: "Renamed",
      });
      expect(renamed.version).toBe(1);
      expect((await db.query("select value_enc from credentials where id=$1", [first.id])).rows).toEqual(before.rows);
      await expect(
        mutateCredentialAccount(store, KEY, people.ada, {
          action: "rename",
          scope: "user",
          id: first.id!,
          name: "Stolen",
        }),
      ).rejects.toThrow(/No such account/);
      await expect(
        resolveCredentials(store, KEY, { ...actor, harness: "claude", credentialId: first.id! }),
      ).rejects.toThrow(/incompatible/);
      await expect(
        setCredential(store, KEY, people.stan, { scope: "user", org: undefined, kind: "openai", value: "overwrite" }),
      ).rejects.toThrow(/Multiple accounts/);
      await expect(
        removeCredential(store, people.stan, { scope: "user", org: undefined, kind: "openai" }),
      ).rejects.toThrow(/Multiple accounts/);
      const shared = await mutateCredentialAccount(store, KEY, people.stan, {
        action: "set",
        scope: "org",
        org: org.id,
        kind: "openai",
        name: "Shared",
        value: "org-key",
      });
      await expect(
        mutateCredentialAccount(store, KEY, people.ada, {
          action: "default",
          scope: "org",
          org: org.id,
          id: shared.id!,
        }),
      ).rejects.toThrow(/Only an org admin/);
      const rotated = await mutateCredentialAccount(store, KEY, people.stan, {
        action: "set",
        scope: "org",
        org: org.id,
        id: shared.id!,
        kind: "openai",
        value: "org-key-new",
        expectedVersion: 1,
      });
      expect(rotated.version).toBe(2);
      await expect(
        mutateCredentialAccount(store, KEY, people.stan, {
          action: "set",
          scope: "org",
          org: org.id,
          id: shared.id!,
          kind: "openai",
          value: "stale-key",
          expectedVersion: 1,
        }),
      ).rejects.toThrow(/revision changed/);
      const member = { ...actor, userId: people.ada, credentialId: shared.id! };
      expect((await resolveCredentials(store, KEY, member)).env).toEqual({ OPENAI_API_KEY: "org-key-new" });
      await mutateCredentialAccount(store, KEY, people.stan, { action: "remove", scope: "user", id: first.id! });
      await expect(resolveCredentials(store, KEY, { ...actor, ...pinned })).rejects.toThrow(/revoked or changed/);
      await db.query("update credentials set status='revoked' where id=$1", [second.id]);
      await expect(resolveCredentials(store, KEY, actor)).rejects.toThrow(/revoked or changed/);
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

  test("a Modal token pair is stored whole, resolved from one scope, and never reaches a model environment", async () => {
    await withVault(async ({ store, people }) => {
      const org = await createOrg(store, people.stan, "Vibe");
      await addMember(store, people.stan, { org: "Vibe", email: "ada@example.com", role: "member" });
      const ada = { userId: people.ada, orgId: org.id };
      const modal = (scope: "user" | "org", who: string, value: string) =>
        setCredential(store, KEY, who, { scope, org: scope === "org" ? "Vibe" : undefined, kind: "modal", value });

      // Half a pair, or halves that are not Modal's, are refused before anything is stored, without echoing them.
      for (const value of ["ak-onlytheid01", '{"token_id":"ak-onlytheid01"}', "as-secret0001 ak-reversed01"]) {
        const refused = await modal("user", people.ada, value).catch((error: Error) => error);
        expect(refused).toBeInstanceOf(VaultError);
        expect((refused as Error).message).not.toContain("onlytheid");
      }
      expect((await listCredentials(store, people.ada, undefined)).user).toEqual([]);

      await modal("org", people.stan, '{"token_id":"ak-orgtoken01","token_secret":"as-orgsecret01"}');
      await modal("user", people.ada, "ak-adatoken01 as-adasecret01");
      const pair = (tokens: { tokenId: string; tokenSecret: string; scope: string }) => [
        tokens.tokenId,
        tokens.tokenSecret,
        tokens.scope,
      ];
      expect(pair(await resolveModalTokens(store, KEY, { ...ada, visibility: "private" }))).toEqual([
        "ak-adatoken01",
        "as-adasecret01",
        "user",
      ]);
      expect(pair(await resolveModalTokens(store, KEY, { ...ada, visibility: "org" }))).toEqual([
        "ak-orgtoken01",
        "as-orgsecret01",
        "org",
      ]);
      // A management credential: no harness resolves it into the sandbox environment.
      await expect(resolveCredentials(store, KEY, { ...ada, harness: "claude" })).rejects.toMatchObject({
        code: "missing_credential",
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
  test("reconnecting B discards cached A and the next launch resolves B", async () => {
    await withVault(async ({ store, db, people }) => {
      await db.query(
        `insert into github_connections (user_id, github_id, login, refresh_token_enc, access_token_enc, access_expires_at)
         values ($1, 1, 'account-a', $2, $3, '2099-01-01')`,
        [people.stan, await encryptSecret("refresh-a", KEY), await encryptSecret("access-a", KEY)],
      );
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [people.stan]);
      await db.query("select save_github_connection(2, 'account-b', null, $1::bytea, null)", [
        await encryptSecret("refresh-b", KEY),
      ]);
      const saved = await store.getGitHubConnection(people.stan);
      expect(saved?.accessTokenEnc).toBeNull();
      expect(saved?.accessExpiresAt).toBeNull();
      const result = await resolveGitHubAccess(
        {
          store,
          encryptionKey: KEY,
          app: { clientId: "app", clientSecret: "secret" },
          fetch: (async (url, init) => {
            if (String(url).includes("access_token")) {
              expect(JSON.parse(String(init?.body)).refresh_token).toBe("refresh-b");
              return Response.json({ access_token: "access-b", refresh_token: "rotated-b", expires_in: 28800 });
            }
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-b");
            return Response.json({ id: 2, login: "account-b", name: null });
          }) as typeof fetch,
        },
        people.stan,
      );
      expect(result).toMatchObject({ status: "connected", token: "access-b", identity: { id: 2 } });
      expect((await store.getGitHubConnection(people.stan))?.githubId).toBe(2);
    });
  });

  test("a failed best-effort profile write does not roll back consumed token rotation", async () => {
    await withVault(async ({ store, db, people }) => {
      await db.query(
        "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 1, 'before', $2)",
        [people.stan, await encryptSecret("refresh-before", KEY)],
      );
      await db.exec(`
        create function refuse_profile() returns trigger language plpgsql as $$
        begin
          if new.login <> old.login then raise exception 'profile unavailable'; end if;
          return new;
        end; $$;
        create trigger refuse_profile before update on github_connections
          for each row execute function refuse_profile();
      `);
      const result = await resolveGitHubAccess(
        {
          store,
          encryptionKey: KEY,
          app: { clientId: "app", clientSecret: "secret" },
          fetch: (async (url) =>
            Response.json(
              String(url).includes("access_token")
                ? { access_token: "access-after", refresh_token: "refresh-after", expires_in: 28800 }
                : { id: 1, login: "renamed", name: null },
            )) as typeof fetch,
        },
        people.stan,
      );
      expect(result.status).toBe("connected");
      const saved = await store.getGitHubConnection(people.stan);
      expect(saved?.login).toBe("before");
      expect(saved?.accessTokenEnc).not.toBeNull();
      if (!saved) throw new Error("Connection disappeared");
      expect(await decryptSecret(new Uint8Array(saved.refreshTokenEnc), KEY)).toBe("refresh-after");
    });
  });

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

  test("a refresh transaction holds its scoped callback until work settles and releases after errors", async () => {
    await withVault(async ({ db, people }) => {
      let tail = Promise.resolve();
      const serialSql: Sql = {
        query: db.query.bind(db),
        autonomousQuery: db.query.bind(db),
        transaction: async <T>(work: (sql: Sql) => Promise<T>) => {
          const previous = tail;
          let release!: () => void;
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await work(serialSql);
          } finally {
            release();
          }
        },
      };
      const first = createSqlVaultStore(serialSql);
      const second = createSqlVaultStore(serialSql);
      let releaseFirst!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const firstRun = first.withGitHubConnectionRefresh(people.stan, async () => {
        firstEntered();
        await held;
      });
      await entered;
      let secondEntered = false;
      const secondRun = second.withGitHubConnectionRefresh(people.stan, async () => {
        secondEntered = true;
      });
      await Promise.resolve();
      expect(secondEntered).toBe(false);
      releaseFirst();
      await Promise.all([firstRun, secondRun]);
      expect(secondEntered).toBe(true);
      await expect(
        first.withGitHubConnectionRefresh(people.stan, async () => {
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await second.withGitHubConnectionRefresh(people.stan, async () => {
        secondEntered = true;
      });
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
