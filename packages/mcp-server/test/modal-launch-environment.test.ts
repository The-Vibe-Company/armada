import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, mutateCredentialAccount } from "@armada/core/server";
import { type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import { modalLaunchEnvironment } from "../src/modal-launch-environment.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { database, ENCRYPTION_KEY, SECRETS } from "./support.ts";

test.each(["claude", "codex"] as const)(
  "GitHub access for %s is immutable launch opt-in, refreshed privately on restore, and never resolved for a golden",
  async (harness) => {
    const { db, people } = await database();
    try {
      const scope: Scope = {
        orgId: people.org,
        userId: people.owner,
        visibility: "private",
        binding: { workspace: "ws", environment: "main", appId: "ap-bound" },
      };
      await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
        scopeKey(scope),
        JSON.stringify(scope),
      ]);
      await db.query(
        "insert into github_connections(user_id,github_id,login,refresh_token_enc) values($1,7,'owner',$2)",
        [people.owner, await encryptSecret("ghr-synthetic", ENCRYPTION_KEY)],
      );
      let clock = Date.now();
      let refreshes = 0;
      let calls = 0;
      const githubFetch = (async (input: string | URL | Request) => {
        calls++;
        if (String(input) === "https://github.com/login/oauth/access_token") {
          refreshes++;
          return Response.json({
            access_token: `ghu-fresh-${refreshes}`,
            refresh_token: `ghr-next-${refreshes}`,
            expires_in: 28_800,
            refresh_token_expires_in: 86400,
          });
        }
        if (String(input) === "https://api.github.com/user")
          return Response.json({ id: 7, login: "owner", name: null });
        throw new Error("Unexpected GitHub endpoint.");
      }) as typeof fetch;
      const resolver = modalLaunchEnvironment({
        sql: db,
        modelAuth: createModelAuthOwnership(db, ENCRYPTION_KEY),
        vault: createSqlVaultStore(db),
        encryptionKey: ENCRYPTION_KEY,
        scope,
        scopeKey: scopeKey(scope),
        callerUserId: people.owner,
        github: {
          store: createSqlVaultStore(db),
          app: { clientId: "synthetic", clientSecret: "synthetic" },
          fetch: githubFetch,
          now: () => new Date(clock),
        },
      });
      const account = await (await import("@armada/core/server")).resolveCredentials(
        createSqlVaultStore(db),
        ENCRYPTION_KEY,
        { userId: people.owner, orgId: people.org, harness },
      );
      const machine = (id: string): Machine => ({
        info: {
          id,
          name: id,
          state: "ready",
          providerState: "active",
          labels: {
            sandbox: crypto.randomUUID(),
            credentialId: account.binding!.credentialId,
            credentialVersion: String(account.binding!.credentialVersion),
          },
        },
        launchUserId: people.owner,
        golden: false,
        phase: "active",
        generation: 1,
        ttlSeconds: 60,
        physicalName: id,
      });
      const launchModel =
        harness === "claude" ? { CLAUDE_CODE_OAUTH_TOKEN: "launch-model" } : { OPENAI_API_KEY: "launch-model" };
      const modelSecret = harness === "claude" ? SECRETS.ownerClaude : SECRETS.orgOpenai;
      const noGithub = machine("without-github");
      const without = await resolver(noGithub, launchModel);
      expect(without.execEnv.GH_TOKEN).toBeUndefined();
      await resolver({ ...noGithub, generation: 2 }, {});
      expect(calls).toBe(0);
      // A later caller cannot turn on GitHub just by supplying different bootstrap aliases.
      expect(
        (
          await resolver(noGithub, {
            ...launchModel,
            GH_TOKEN: "untrusted-later",
          })
        ).execEnv.GH_TOKEN,
      ).toBeUndefined();
      expect(calls).toBe(0);

      const enabled = machine("with-github");
      const first = await resolver(enabled, {
        ...launchModel,
        GH_TOKEN: "launch-github",
        GITHUB_TOKEN: "launch-github",
      });
      expect(first.execEnv).toMatchObject({
        GH_TOKEN: "ghu-fresh-1",
        GITHUB_TOKEN: "ghu-fresh-1",
        GIT_TERMINAL_PROMPT: "0",
      });
      const selected = harness === "claude" ? first.claudeEnv : first.codexEnv;
      const unselected = harness === "claude" ? first.codexEnv : first.claudeEnv;
      expect(selected[harness === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : "OPENAI_API_KEY"]).toBe(modelSecret);
      expect(unselected).toEqual({});
      expect(Object.values(first.execEnv)).not.toContain(modelSecret);
      expect(selected.GH_TOKEN).toBe("ghu-fresh-1");
      expect(selected.GITHUB_TOKEN).toBe("ghu-fresh-1");
      // Restoring with six minutes left must renew, not inherit a nearly expired owner token.
      clock += (7 * 60 + 54) * 60_000;
      const restored = await resolver({ ...enabled, generation: 2 }, {});
      expect(restored.execEnv.GH_TOKEN).toBe("ghu-fresh-2");
      expect((harness === "claude" ? restored.claudeEnv : restored.codexEnv).GH_TOKEN).toBe("ghu-fresh-2");
      expect(refreshes).toBe(2);
      const metadata = (await db.query("select harness,github_enabled from modal_server_harnesses order by machine_id"))
        .rows;
      expect(metadata).toEqual([
        { harness, github_enabled: true },
        { harness, github_enabled: false },
      ]);
      for (const secret of ["launch-model", "launch-github", "ghu-fresh-1", "ghu-fresh-2", modelSecret])
        expect(JSON.stringify(metadata)).not.toContain(secret);
      const beforeBuilder = calls;
      await expect(resolver({ ...enabled, golden: true }, {})).rejects.toMatchObject({ code: "forbidden" });
      expect(calls).toBe(beforeBuilder);
      await db.query("delete from github_connections where user_id=$1", [people.owner]);
      await expect(resolver({ ...enabled, generation: 3 }, {})).rejects.toMatchObject({ code: "unavailable" });
      expect((await resolver({ ...noGithub, generation: 3 }, {})).execEnv.GH_TOKEN).toBeUndefined();
    } finally {
      await db.close();
    }
  },
);

test("Modal bootstrap and restore use the explicit pinned account rather than current defaults", async () => {
  const { db, people } = await database();
  try {
    const scope: Scope = {
      orgId: people.org,
      userId: people.owner,
      visibility: "private",
      binding: { workspace: "ws", environment: "main", appId: "ap-bound" },
    };
    await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
      scopeKey(scope),
      JSON.stringify(scope),
    ]);
    const store = createSqlVaultStore(db);
    const original = (await store.listCredentials("user", people.owner)).find((row) => row.kind === "claude_oauth")!;
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.owner, {
      action: "default",
      scope: "user",
      id: original.id!,
    });
    const selected = await mutateCredentialAccount(store, ENCRYPTION_KEY, people.owner, {
      action: "set",
      scope: "user",
      kind: "claude_oauth",
      name: "Explicit",
      value: "explicit-modal-account",
    });
    const machine: Machine = {
      info: {
        id: "pinned-account",
        name: "pinned",
        state: "ready",
        providerState: "active",
        labels: { credentialId: selected.id!, credentialVersion: String(selected.version) },
      },
      launchUserId: people.owner,
      golden: false,
      phase: "active",
      generation: 1,
      ttlSeconds: 60,
      physicalName: "pinned",
    };
    const resolver = modalLaunchEnvironment({
      sql: db,
      vault: store,
      encryptionKey: ENCRYPTION_KEY,
      scope,
      scopeKey: scopeKey(scope),
      callerUserId: people.owner,
    });
    expect(
      (await resolver(machine, { CLAUDE_CODE_OAUTH_TOKEN: "explicit-modal-account" })).claudeEnv
        .CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe("explicit-modal-account");
    await expect(
      db.query("update modal_server_harnesses set credential_version=null where scope=$1 and machine_id=$2", [
        scopeKey(scope),
        machine.info.id,
      ]),
    ).rejects.toThrow(/modal_harness_credential_binding_chk/);
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.owner, {
      action: "default",
      scope: "user",
      id: selected.id!,
    });
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.owner, {
      action: "default",
      scope: "user",
      id: original.id!,
    });
    expect((await resolver({ ...machine, generation: 2 }, {})).claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "explicit-modal-account",
    );
    await mutateCredentialAccount(store, ENCRYPTION_KEY, people.owner, {
      action: "remove",
      scope: "user",
      id: selected.id!,
    });
    await expect(resolver({ ...machine, generation: 3 }, {})).rejects.toThrow(/No fallback was used/);
  } finally {
    await db.close();
  }
});

test("Modal native Codex bootstrap still requires actual rotating-account ownership", async () => {
  const { db, people } = await database();
  try {
    const scope: Scope = {
      orgId: people.org,
      userId: people.owner,
      visibility: "private",
      binding: { workspace: "ws", environment: "main", appId: "ap-bound" },
    };
    await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
      scopeKey(scope),
      JSON.stringify(scope),
    ]);
    const account = await mutateCredentialAccount(createSqlVaultStore(db), ENCRYPTION_KEY, people.owner, {
      action: "set",
      scope: "user",
      kind: "codex_auth",
      name: "Native bootstrap contract",
      value: JSON.stringify({
        tokens: {
          access_token: "synthetic-modal-native-access",
          refresh_token: "synthetic-modal-native-refresh",
          account_id: "synthetic-modal-native-account",
        },
      }),
    });
    const machine: Machine = {
      info: {
        id: "native-unclaimed",
        name: "native",
        state: "ready",
        providerState: "active",
        labels: { sandbox: crypto.randomUUID(), credentialId: account.id!, credentialVersion: String(account.version) },
      },
      launchUserId: people.owner,
      golden: false,
      phase: "active",
      generation: 1,
      ttlSeconds: 60,
      physicalName: "native",
    };
    const resolve = modalLaunchEnvironment({
      sql: db,
      vault: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      scope,
      scopeKey: scopeKey(scope),
      callerUserId: people.owner,
      modelAuth: createModelAuthOwnership(db, ENCRYPTION_KEY),
    });
    await expect(resolve(machine, { ARMADA_CODEX_AUTH_JSON: "initial-native-selection" })).rejects.toMatchObject({
      code: "credential_binding_required",
    });
    await expect(resolve({ ...machine, generation: 2 }, {})).rejects.toMatchObject({
      code: "credential_binding_required",
    });
  } finally {
    await db.close();
  }
});

// Token resolution in these fixtures must not leak audit records to stdout.
captureGitHubAuditLogs();

test("shared Codex Modal bootstrap contains only the private access grant, never refresh-bearing auth", async () => {
  const { db, people } = await database();
  try {
    const scope: Scope = {
      orgId: people.org,
      userId: people.owner,
      visibility: "private",
      binding: { workspace: "ws", environment: "main", appId: "ap-shared" },
    };
    await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
      scopeKey(scope),
      JSON.stringify(scope),
    ]);
    const raw = JSON.stringify({
      tokens: {
        access_token: "private-initial-access",
        refresh_token: "private-shared-refresh",
        account_id: "shared-account",
      },
    });
    const account = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'codex_auth',$2) returning id",
        [people.owner, await encryptSecret(raw, ENCRYPTION_KEY)],
      )
    ).rows[0]!;
    const auth = createModelAuthOwnership(db, ENCRYPTION_KEY, undefined, undefined, undefined, {
      origin: "https://armada.example",
    });
    await auth.broker!.enroll({ userId: people.owner, orgId: people.org, role: "member" }, account.id, 1);
    const resolver = modalLaunchEnvironment({
      sql: db,
      modelAuth: auth,
      vault: createSqlVaultStore(db),
      encryptionKey: ENCRYPTION_KEY,
      scope,
      scopeKey: scopeKey(scope),
      callerUserId: people.owner,
    });
    const machine: Machine = {
      info: {
        id: "shared-machine",
        name: "shared",
        state: "ready",
        providerState: "active",
        labels: { sandbox: crypto.randomUUID(), credentialId: account.id, credentialVersion: "1" },
      },
      launchUserId: people.owner,
      golden: false,
      phase: "active",
      generation: 1,
      ttlSeconds: 3600,
      physicalName: "shared-machine",
    };
    const configuration = await resolver(machine, { ARMADA_SERVER_CODEX: "1" });
    expect(configuration.subscription?.url).toBe("https://armada.example/api/internal/model/access");
    expect(configuration.subscription?.capability).toBeTruthy();
    expect(configuration.codexAuthJson).toBeUndefined();
    expect(configuration.nativeAuthRevision).toBeUndefined();
    expect(JSON.stringify(configuration)).not.toContain("private-shared-refresh");
    expect(JSON.stringify(configuration)).not.toContain("private-initial-access");
    expect(configuration.codexEnv.ARMADA_CODEX_AUTH_JSON).toBeUndefined();
  } finally {
    await db.close();
  }
});
