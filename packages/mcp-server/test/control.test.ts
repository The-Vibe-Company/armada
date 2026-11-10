import { describe, expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, memorySessionStore, sha256Hex } from "@armada/auth";
import {
  createSqlVaultStore,
  DEFAULT_LAUNCH_TTL_SECONDS,
  encryptSecret,
  HARNESS_KINDS,
  HARNESSES,
  MACHINE_SIZES,
  MODEL_CATALOG,
  PROVIDER_LIMITS,
  ProviderError,
  resolveBoatKey,
  resolveCredentials,
  VaultError,
  type VaultStore,
} from "@armada/core";
import { type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { createCredentialBindingRecovery } from "../src/credential-binding-recovery.ts";
import { type ControlOptions, controlOptionsFromEnv, createSqlData, handleControlRequest } from "../src/index.ts";
import { modalLaunchEnvironment } from "../src/modal-launch-environment.ts";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createProviderMetadata } from "../src/provider-metadata.ts";
import { fakeBoat } from "./support.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");
const STAN = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const TOKEN_SECRET = "sk-ant-oat01-do-not-leak";
const AUTH_JSON = '{"tokens":{"access_token":"codex-do-not-leak"}}';

// The HTTP contract owns classification: real SQL resolution and launch, not a mocked classifier.
for (const failure of [
  "credential_refused",
  "provider_unavailable",
  "dependency_unavailable",
  "outcome_unknown",
] as const) {
  test(`launch HTTP separates ${failure} without parsing diagnostic text`, async () => {
    await withServer(async ({ db, options }) => {
      const org = await options.store.createOrg("Failures", STAN);
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`;
      await db.query("update orgs set boat_api_key_enc=$1 where id=$2", [
        await encryptSecret("provider-key", KEY),
        org.id,
      ]);
      await db.query(
        "insert into credentials(scope,owner_id,kind,value_enc,status) values('user',$1,'claude_oauth',$2,$3)",
        [STAN, await encryptSecret("model-key", KEY), failure === "credential_refused" ? "revoked" : "active"],
      );
      await db.query(
        "insert into goldens(org_id,name,visibility,owner_id,boat_snapshot_id,config) values($1,'web','org',$2,$3,$4::jsonb)",
        [
          org.id,
          STAN,
          `a${"b".repeat(62)}`,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const boat = fakeBoat();
      boat.provider.fork = async () => {
        throw new ProviderError({
          provider: "boat",
          code: "unavailable",
          message: "credential_refused expired revoked (not a classification input)",
          retryable: true,
          ...(failure === "provider_unavailable" ? { status: 503 } : {}),
        });
      };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ golden: "web", harness: "claude" }),
        }),
        {
          ...options,
          ...(failure === "dependency_unavailable"
            ? {}
            : {
                providerFor: () => {
                  if (failure === "provider_unavailable")
                    throw new ProviderError({
                      provider: "boat",
                      code: "unavailable",
                      message: "Provider discovery failed.",
                      retryable: true,
                      status: 503,
                    });
                  return boat.provider;
                },
              }),
        },
      );
      expect(response?.status).toBe(
        failure === "credential_refused" ? 422 : failure === "provider_unavailable" ? 502 : 503,
      );
      expect(await response?.json()).toMatchObject({ error: { code: failure } });
      expect((await db.query("select id from sandboxes")).rows).toEqual([]);
    });
  });
}

describe("armada org and armada creds against the control API", () => {
  test("organization setup is org-only, live-authorized, validated and encrypted through CLI/API", async () => {
    await withServer(async ({ db, options, cli }) => {
      const admin = cli(STAN);
      const member = cli(ADA);
      await admin.run(["org", "create", "Setup"]);
      const org = (await options.store.memberships(STAN))[0]!;
      await options.store.addMember(org.id, ADA, "member");
      let calls = 0;
      options.providerValidator = async () => {
        calls++;
      };
      await member.run(["creds", "set", "boat"], { stdin: "personal-test-value" });
      const status = async () => JSON.parse((await member.run(["org", "setup", "--json"])).out);
      expect(await status()).toEqual({
        org: { ...org, role: "member" },
        ready: false,
        providers: [
          { provider: "boat", configured: false },
          { provider: "modal", configured: false },
        ],
      });
      expect((await member.run(["org", "connect", "boat"], { stdin: "test-value" })).code).toBe(1);
      expect(calls).toBe(0);
      for (const code of ["invalid", "unavailable"] as const) {
        options.providerValidator = async () => {
          calls++;
          throw new VaultError(code, "sensitive-provider-message");
        };
        const failed = await admin.run(["org", "connect", "boat"], { stdin: "test-value" });
        expect(failed.code).toBe(1);
        expect(failed.err).not.toContain("sensitive-provider-message");
        expect((await status()).ready).toBe(false);
      }
      await options.store.setMemberRole(org.id, ADA, "admin");
      options.providerValidator = async () => {
        await options.store.setMemberRole(org.id, STAN, "member");
      };
      expect((await admin.run(["org", "connect", "boat"], { stdin: "test-value" })).code).toBe(1);
      expect((await status()).ready).toBe(false);
      await options.store.setMemberRole(org.id, STAN, "admin");
      options.providerValidator = async () => {
        calls++;
      };
      expect((await admin.run(["org", "connect", "boat", "extra-secret"], { stdin: "test-value" })).code).not.toBe(0);
      expect((await admin.run(["org", "connect", "boat"], { stdin: "test-value" })).code).toBe(0);
      expect((await status()).providers[0].configured).toBe(true);
      expect(await resolveBoatKey(options.store, KEY, { userId: STAN, orgId: org.id, visibility: "org" })).toEqual({
        key: "test-value",
        scope: "org",
      });
      expect(
        JSON.parse((await member.run(["creds", "list", "--org", org.id, "--json"])).out).orgs[0].credentials,
      ).toEqual([{ kind: "boat", createdAt: null }]);
      expect((await admin.run(["creds", "rm", "boat", "--org", org.id])).code).toBe(0);
      expect((await status()).ready).toBe(false);
      await expect(
        resolveBoatKey(options.store, KEY, { userId: STAN, orgId: org.id, visibility: "org" }),
      ).rejects.toThrow(/no boat.dev key/);
      await options.store.upsertCredential("org", org.id, "modal", await encryptSecret("test-value", KEY));
      expect((await status()).ready).toBe(true);
      await options.store.deleteCredential("org", org.id, "modal");
      const pair = JSON.stringify({ token_id: "ak-test12345678", token_secret: "as-test12345678" });
      expect((await admin.run(["org", "connect", "modal", "--file", "input"], { files: { input: pair } })).code).toBe(
        0,
      );
      expect((await status()).providers[1].configured).toBe(true);
      const service = generateToken("service");
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      await options.authStore.insertToken("service", {
        userId: STAN,
        orgId: org.id,
        hash: await sha256Hex(service),
        label: "test",
        createdAt: new Date().toISOString(),
      });
      const other = await options.store.createOrg("Other", STAN);
      const request = (body: unknown) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/org/provider/connect", {
            method: "POST",
            headers: { authorization: `Bearer ${service}` },
            body: JSON.stringify(body),
          }),
          options,
        );
      const implicit = await handleControlRequest(
        new Request("https://armada.test/api/v1/org/provider/status", {
          method: "POST",
          headers: { authorization: `Bearer ${service}` },
          body: "{}",
        }),
        options,
      );
      expect(implicit?.status).toBe(200);
      expect(await implicit?.json()).toMatchObject({ org: { id: org.id } });
      const before = calls;
      expect((await request({ org: org.id, provider: "boat", value: "x".repeat(16_385) }))?.status).toBe(400);
      expect((await request({ org: other.id, provider: "boat", value: "test-value" }))?.status).toBe(404);
      await options.store.removeMember(org.id, STAN);
      expect((await request({ org: org.id, provider: "boat", value: "test-value" }))?.status).toBe(404);
      expect(calls).toBe(before);
      const stored = await db.query<{ value_enc: Uint8Array }>("select value_enc from credentials where owner_id=$1", [
        org.id,
      ]);
      expect(JSON.stringify(stored.rows)).not.toContain("test12345678");
    });
  });

  test("org provider disconnect is admin-only and live-checked; a rejected replacement keeps the stored key", async () => {
    await withServer(async ({ options }) => {
      const org = await options.store.createOrg("Providers", STAN);
      await options.store.addMember(org.id, ADA, "member");
      const post = async (who: string, route: string, body: Record<string, unknown>) => {
        const session = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: who })).replace(/=+$/, "")}.sig`;
        const response = await handleControlRequest(
          new Request(`https://armada.test/api/v1/org/provider/${route}`, {
            method: "POST",
            headers: { authorization: `Bearer ${session}` },
            body: JSON.stringify({ org: org.id, ...body }),
          }),
          options,
        );
        return {
          status: response?.status,
          body: (await response?.json()) as {
            ready: boolean;
            org: { id: string; role: string };
            providers: { provider: string; configured: boolean }[];
          },
        };
      };
      const configured = async () =>
        Object.fromEntries(
          (await post(STAN, "status", {})).body.providers.map((item) => [item.provider, item.configured]),
        );
      options.providerValidator = async () => {};
      const pair = JSON.stringify({ token_id: "ak-test12345678", token_secret: "as-test12345678" });
      expect((await post(STAN, "connect", { provider: "boat", value: "first-value" })).status).toBe(200);
      expect((await post(STAN, "connect", { provider: "modal", value: pair })).status).toBe(200);

      options.providerValidator = async () => {
        throw new VaultError("invalid", "rejected");
      };
      expect((await post(STAN, "connect", { provider: "boat", value: "second-value" })).status).toBe(400);
      expect(await resolveBoatKey(options.store, KEY, { userId: ADA, orgId: org.id, visibility: "org" })).toEqual({
        key: "first-value",
        scope: "org",
      });

      expect((await post(ADA, "disconnect", { provider: "boat" })).status).toBe(403);
      expect((await post(STAN, "disconnect", { provider: "e2b" })).status).toBe(400);
      expect(await configured()).toEqual({ boat: true, modal: true });

      const one = await post(STAN, "disconnect", { provider: "boat" });
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ org: { id: org.id, role: "admin" }, ready: true });
      expect(await configured()).toEqual({ boat: false, modal: true });
      // Already gone is the requested state, answered with the current status.
      expect((await post(STAN, "disconnect", { provider: "boat" })).body.ready).toBe(true);

      // The role is read again: a demoted admin cannot disconnect the last provider.
      await options.store.setMemberRole(org.id, ADA, "admin");
      await options.store.setMemberRole(org.id, STAN, "member");
      expect((await post(STAN, "disconnect", { provider: "modal" })).status).toBe(403);
      const last = await post(ADA, "disconnect", { provider: "modal" });
      expect(last.body.ready).toBe(false);
      expect(await configured()).toEqual({ boat: false, modal: false });
    });
  });

  test("an org is created, members and credentials are managed, and launch resolves them", async () => {
    await withServer(async ({ db, options, cli }) => {
      const stan = cli(STAN);
      const ada = cli(ADA);
      const secrets = [TOKEN_SECRET, "codex-do-not-leak", "boat-org-key", "boat-ada-key"];
      const everything = () => [stan, ada].map((who) => who.out + who.err).join("");

      expect((await stan.run(["org", "create", "Vibe"])).code).toBe(0);
      expect((await stan.run(["org", "list"])).out).toContain("Vibe  admin");
      expect((await stan.run(["org", "members", "add", "Ada@Example.com"])).out).toContain(
        "Added ada@example.com as member.",
      );
      expect((await stan.run(["org", "members", "list"])).out).toContain("ada@example.com  member");

      expect(
        (await stan.run(["creds", "set", "claude-oauth", "--org", "Vibe"], { stdin: `${TOKEN_SECRET}\n` })).code,
      ).toBe(0);
      expect((await stan.run(["creds", "set", "boat", "--org", "Vibe"], { stdin: "boat-org-key" })).code).toBe(0);
      expect(
        (
          await stan.run(["creds", "set", "codex-auth", "--file", "/home/stan/auth.json"], {
            files: { "/home/stan/auth.json": AUTH_JSON },
          })
        ).code,
      ).toBe(0);
      expect((await ada.run(["creds", "set", "boat"], { stdin: "boat-ada-key" })).code).toBe(0);

      const adaSees = await ada.run(["creds", "list"]);
      expect(adaSees.out).toContain("You:\n  boat");
      expect(adaSees.out).toContain("Org Vibe (member):\n  boat\n  claude-oauth");
      expect(adaSees.out).not.toContain("codex-auth");
      const denied = await ada.run(["creds", "set", "anthropic", "--org", "Vibe"], { stdin: "sk-ant-api03-x" });
      expect(denied.code).toBe(1);
      expect(denied.err).toContain("Only an org admin can do that.");
      expect((await ada.run(["creds", "rm", "claude-oauth", "--org", "Vibe"])).code).toBe(1);
      expect((await ada.run(["org", "members", "remove", "stan@example.com"])).err).toContain("Only an org admin");

      const org = (await options.store.memberships(STAN))[0];
      const resolved = await resolveCredentials(options.store, KEY, {
        userId: ADA,
        orgId: org?.id ?? "",
        harness: "claude",
      });
      expect(resolved.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_SECRET });
      const boat = await resolveBoatKey(options.store, KEY, {
        userId: ADA,
        orgId: org?.id ?? "",
        visibility: "private",
      });
      expect(boat).toEqual({ key: "boat-ada-key", scope: "user" });

      const stored = await db.query<{ blob: string }>(
        "select coalesce(string_agg(encode(value_enc, 'escape'), ' '), '') || coalesce((select string_agg(encode(boat_api_key_enc, 'escape'), ' ') from orgs), '') as blob from credentials",
      );
      for (const secret of secrets) {
        expect(stored.rows[0]?.blob).not.toContain(secret);
        expect(everything()).not.toContain(secret);
      }

      expect((await stan.run(["creds", "rm", "boat", "--org", "Vibe"])).code).toBe(0);
      expect((await stan.run(["creds", "list", "--org", "Vibe"])).out).not.toContain("  boat");
    });
  });

  test("CLI sandbox list shares the MCP scoped operation and rejects unavailable registry features", async () => {
    await withServer(async ({ options, cli }) => {
      const stan = cli(STAN);
      await stan.run(["org", "create", "SandboxScope"]);
      options.providers = { resolve: async () => fakeProvider() };
      const listed = await stan.run(["list", "--json"]);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.out)).toEqual({ sandboxes: [] });
      const missing = await stan.run(["status", "33333333-3333-4333-8333-333333333333"]);
      expect(missing.code).not.toBe(0);
      expect(missing.out).toBe("");
      const mcp = await stan.run(["mcp", "list"]);
      expect(mcp.code).not.toBe(0);
      expect(mcp.out).toBe("");
    });
  });

  test("a value is read from stdin or a file, never from an argument", async () => {
    await withServer(async ({ cli }) => {
      const stan = cli(STAN);
      await stan.run(["org", "create", "Vibe"]);
      const tty = await stan.run(["creds", "set", "openai"], { stdin: null });
      expect(tty.code).toBe(2);
      expect(tty.err).toContain("Pipe the value on stdin");
      const extra = await stan.run(["creds", "set", "openai", "sk-pasted-on-the-command-line"]);
      expect(extra.code).toBe(2);
      expect(extra.err).not.toContain("sk-pasted");
      const unknown = await stan.run(["creds", "set", "opencode"], { stdin: "x" });
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("Unknown credential 'opencode'");
      const spaced = await stan.run(["creds", "set", "openai"], { stdin: "sk one two" });
      expect(spaced.code).toBe(2);
      expect(spaced.err).not.toContain("one two");
    });
  });

  test("armada logs resolves an Armada id through the authenticated server, without a local boat key", async () => {
    await withServer(async ({ db, options }) => {
      const org = crypto.randomUUID();
      await db.query("insert into orgs (id, name) values ($1, 'Logs')", [org]);
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'admin')", [org, STAN]);
      await db.query(
        `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
         values ($1, 'web', 'org', $2, $3, $4::jsonb)`,
        [org, STAN, `a${"b".repeat(62)}`, JSON.stringify({ repos: [], init: [] })],
      );
      const golden = await db.query<{ id: string }>("select id from goldens where name = 'web'");
      const armadaId = "33333333-3333-4333-8333-333333333333";
      await db.query(
        `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status)
         values ($1, 'bx_server_only', $2, $3, $4, 'claude', 'ready')`,
        [armadaId, golden.rows[0]?.id, org, STAN],
      );
      const calls: { path: string; authorization: string | null }[] = [];
      const logsOptions: ControlOptions = {
        ...options,
        logs: async (caller, id) => {
          expect(caller.userId).toBe(STAN);
          expect(id).toBe(armadaId);
          return {
            providerSandboxId: "bx_server_only",
            provider: {
              id: "boat",
              harnesses: ["claude", "codex"],
              capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } } as never,
              async events(request: { sandboxId: string }) {
                calls.push({ path: request.sandboxId, authorization: "server-resolved" });
                return {
                  events: [{ id: "ev_1", at: 1, kind: "message", text: "from server" }],
                  cursor: "1",
                  hasMore: false,
                };
              },
              async get() {
                return { id: "bx_server_only", name: "x", state: "stopped", providerState: "stopped", labels: {} };
              },
            } as never,
          };
        },
      };
      let out = "";
      let err = "";
      const auth: AuthIo = {
        out: (text) => (out += text),
        err: (text) => (err += text),
        env: { ARMADA_URL: "https://armada.test", SUPABASE_ANON_KEY: "anon" },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          return (await handleControlRequest(request, logsOptions)) ?? new Response("{}", { status: 404 });
        },
        now: () => new Date(),
        open: () => undefined,
        session: memorySessionStore({
          userId: STAN,
          accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          refreshToken: "r",
          expiresAt: "2099-01-01T00:00:00.000Z",
          supabaseUrl: "https://supabase.test",
        }),
      };
      expect(await run(["logs", armadaId], { out: auth.out, err: auth.err }, { auth })).toBe(0);
      expect(out).toBe("from server\n");
      expect(err).toBe("");
      expect(calls).toEqual([{ path: "bx_server_only", authorization: "server-resolved" }]);
    });
  });

  test.each([true, false])("logs tail settles without draining history (follow=%s)", async (follow) => {
    // All variants are read-only; migrate one database rather than repeating the
    // same setup four times inside one bounded behavioral test.
    await withServer(async ({ options }) => {
      for (const status of [null, "finished", "failed", "interrupted"] as const) {
        const armadaId = "44444444-4444-4444-8444-444444444444";
        const prompt = status
          ? [{ id: `prompt-${status}`, at: 1, kind: "prompt" as const, promptId: "pr_1", text: "go" }]
          : [];
        let reads = 0;
        const logs: ControlOptions = {
          ...options,
          logs: async () => ({
            providerSandboxId: "bx_follow",
            provider: {
              id: "boat",
              harnesses: ["claude", "codex"],
              capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } } as never,
              async events() {
                reads++;
                if (reads > 1) throw new Error("History was drained behind a tail read");
                return { events: prompt, cursor: status ? "cursor" : undefined, hasMore: false };
              },
              async get() {
                return { id: "bx_follow", name: "x", state: "ready", providerState: "ready", labels: {} };
              },
              async getPrompt() {
                return { promptId: "pr_1", status: status ?? "running", done: status !== null };
              },
            } as never,
          }),
        };
        const response = await handleControlRequest(
          new Request("https://armada.test/api/v1/logs/read", {
            method: "POST",
            headers: {
              authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
            },
            body: JSON.stringify({ id: armadaId, follow, direction: "backward" }),
          }),
          logs,
        );
        expect(response?.status).toBe(200);
        if (!response) throw new Error("expected response");
        expect(((await response.json()) as { settled: boolean }).settled).toBe(true);
        expect(reads).toBe(1);
      }
    });
  });

  test("logs follow settles when an empty page has no prompt and preserves its cursor", async () => {
    await withServer(async ({ options }) => {
      const logs: ControlOptions = {
        ...options,
        logs: async () => ({
          providerSandboxId: "bx_follow",
          provider: {
            id: "boat",
            harnesses: ["claude", "codex"],
            capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } } as never,
            async events() {
              return { events: [], cursor: undefined, hasMore: false };
            },
            async get() {
              return { id: "bx_follow", name: "x", state: "ready", providerState: "ready", labels: {} };
            },
          } as never,
        }),
      };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/logs/read", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", follow: true, cursor: "keep" }),
        }),
        logs,
      );
      expect((await response?.json()) as object).toMatchObject({
        events: [],
        cursor: "keep",
        hasMore: false,
        settled: true,
      });
    });
  });

  test("the CLI needs a login and a server address", async () => {
    await withServer(async ({ cli }) => {
      const nobody = cli(STAN, { session: false });
      expect((await nobody.run(["org", "list"])).err).toContain("run armada login.");
      const lost = cli(STAN, { armadaUrl: false });
      expect((await lost.run(["org", "list"])).err).toContain("Armada could not reach the server.");
      const refused = cli(STAN, { token: "revoked" });
      const result = await refused.run(["org", "list"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("Run armada login again.");
    });
  });
});

describe("control API", () => {
  test("uncertain retained provider outcomes preserve only recovery metadata", async () => {
    await withServer(async ({ db, options }) => {
      const org = await options.store.createOrg("Provider failure", STAN);
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      const golden = await db.query<{ id: string }>(
        "insert into goldens(org_id, owner_id, name, visibility, config) values($1,$2,'failure','org',$3::jsonb) returning id",
        [
          org.id,
          STAN,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const sandbox = await db.query<{ id: string }>(
        "insert into sandboxes(org_id, owner_id, golden_id, boat_id, harness, status) values($1,$2,$3,'bx_failure','claude','ready') returning id",
        [org.id, STAN, golden.rows[0]!.id],
      );
      options.providerFor = () => fakeBoat().provider;
      options.providers = {
        resolve: async () => {
          throw new ProviderError({
            provider: "boat",
            code: "unknown",
            message: "The provider failed.",
            details: { keepSource: true, sourceSandboxId: "retained-source", internal: "not-public" },
            retryable: true,
          });
        },
      };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/golden/connect", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify({ name: "failure", org: org.id }),
        }),
        options,
      );
      expect(response?.status).toBe(503);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.json()).toEqual({
        error: {
          code: "outcome_unknown",
          message: "The provider failed.",
          details: { keepSource: true, sourceSandboxId: "retained-source" },
        },
      });
      // Retained resource evidence and lost mutation receipts both require reconciliation.
      const boat = fakeBoat();
      let dispatched = 0;
      boat.provider.get = async (id) => ({ id, name: "failure", state: "ready", providerState: "ready", labels: {} });
      boat.provider.prompt = async () => {
        dispatched++;
        throw new ProviderError({ provider: "boat", code: "unavailable", message: "Lost receipt", retryable: true });
      };
      options.providers = { resolve: async () => boat.provider };
      const send = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/send", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify({ id: sandbox.rows[0]!.id, prompt: "continue" }),
        }),
        options,
      );
      expect(dispatched).toBe(1);
      expect(send?.status).toBe(503);
      expect(await send?.json()).toMatchObject({ error: { code: "outcome_unknown" } });
    });
  });

  test("launch/options publishes the server's harness, model, size and TTL catalogs to a signed-in caller", async () => {
    await withServer(async ({ options }) => {
      const call = (init: RequestInit) =>
        handleControlRequest(new Request("https://armada.test/api/v1/launch/options", init), options);
      expect((await call({ method: "POST" }))?.status).toBe(401);
      const headers = {
        authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
      };
      const response = await call({ method: "POST", headers, body: "{}" });
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as {
        harnesses: { id: string; defaultModel: string; models: unknown; credentialKinds: unknown }[];
        machineSizes: unknown;
        ttl: unknown;
      };
      expect(body.harnesses.map((harness: { id: string }) => harness.id)).toEqual([...HARNESSES]);
      for (const harness of body.harnesses) {
        const catalog = MODEL_CATALOG[harness.id as keyof typeof MODEL_CATALOG];
        expect(harness.defaultModel).toBe(catalog.defaultModel);
        expect(harness.models).toEqual(catalog.models);
        expect(harness.credentialKinds).toEqual(HARNESS_KINDS[harness.id as keyof typeof HARNESS_KINDS]);
      }
      expect(body.machineSizes).toEqual([...MACHINE_SIZES]);
      expect(body.ttl).toEqual({
        defaultSeconds: DEFAULT_LAUNCH_TTL_SECONDS,
        maxSeconds: { boat: PROVIDER_LIMITS.boat.maxTtlSeconds, modal: PROVIDER_LIMITS.modal.maxTtlSeconds },
      });
    });
  });

  test("only POST to /api/v1/ with a valid Supabase session is served", async () => {
    await withServer(async ({ options }) => {
      const call = (path: string, init: RequestInit) =>
        handleControlRequest(new Request(`https://armada.test${path}`, init), options);
      expect(await call("/mcp", { method: "POST" })).toBeNull();
      expect((await call("/api/v1/org/list", { method: "GET" }))?.status).toBe(405);
      expect((await call("/api/v1/org/list", { method: "POST" }))?.status).toBe(401);
      const bad = await call("/api/v1/org/list", { method: "POST", headers: { authorization: "Bearer revoked" } });
      expect(bad?.status).toBe(401);
      const headers = {
        authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
      };
      expect((await call("/api/v1/nope", { method: "POST", headers }))?.status).toBe(404);
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{" }))?.status).toBe(400);
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{}" }))?.status).toBe(400);
      expect((await call("/api/v1/org/list", { method: "POST", headers }))?.status).toBe(200);
    });
  });

  test("golden/create accepts a normalized config and rejects malformed config safely", async () => {
    await withServer(async ({ options }) => {
      const org = (await options.store.createOrg("Create", STAN)).id;
      await options.store.setOrgBoatKey(org, await encryptSecret("boat-test", KEY));
      options.authStore.addMembership(STAN, { orgId: org, name: "Create", role: "admin" });
      const service = {
        admit: async (_provider: unknown, _actor: unknown, input: unknown) => {
          expect(input).toMatchObject({
            repos: [],
            config: {
              repos: [{ owner: "acme", repo: "web", branch: "feature/login", dir: "frontend" }],
              init: ["pnpm install"],
            },
          });
          return { jobId: "job-fixture", state: "queued", phase: "queued", errorCode: null, result: null };
        },
      } as never;
      const session = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`;
      const request = (body: object) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/golden/create", {
            method: "POST",
            headers: { authorization: `Bearer ${session}` },
            body: JSON.stringify({ idempotencyKey: "valid-idempotency-key", ...body }),
          }),
          { ...options, goldenBuilds: service, providerFor: () => ({}) as never },
        );
      const ok = await request({
        name: "web",
        idempotencyKey: crypto.randomUUID(),
        private: true,
        config: {
          repos: [{ url: "https://github.com/acme/web.git", branch: "feature/login", dir: "frontend" }],
          init: ["pnpm install"],
        },
      });
      expect(ok?.status).toBe(202);
      expect(await ok?.json()).toMatchObject({ jobId: "job-fixture", state: "queued", result: null });
      const bad = await request({ name: "web", config: { repos: [{ url: "https://evil.example/acme/web.git" }] } });
      expect(bad?.status).toBe(400);
      expect(await bad?.text()).not.toContain("evil.example");
    });
  });

  for (const repo of [undefined, "ACME/web"]) {
    test(`sandbox/launch uses scoped credentials and forwards repo (${repo ?? "omitted"})`, async () => {
      await withServer(async ({ db, options }) => {
        const org = (await options.store.createOrg("Launch", STAN)).id;
        options.authStore.addMembership(STAN, { orgId: org, name: "Launch", role: "admin" });
        const key = await encryptSecret("server-only-boat-key", KEY);
        await db.query("update orgs set boat_api_key_enc = $1 where id = $2", [key, org]);
        await db.query(
          "insert into credentials (scope, owner_id, kind, value_enc) values ('user', $1, 'claude_oauth', $2)",
          [STAN, await encryptSecret("server-only-model-token", KEY)],
        );
        await db.query(
          "insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values ($1, 'web', 'org', $2, $3, $4::jsonb)",
          [
            org,
            STAN,
            `a${"b".repeat(62)}`,
            JSON.stringify({
              repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }],
              init: [],
            }),
          ],
        );
        const service = generateToken("service");
        await options.authStore.insertToken("service", {
          userId: STAN,
          orgId: org,
          hash: await sha256Hex(service),
          label: "ci",
          createdAt: new Date().toISOString(),
        });
        const boat = fakeBoat();
        // Registration must work with the production server role, not just the database owner.
        await db.exec("set role service_role");
        const launch = (body: Record<string, unknown>) =>
          handleControlRequest(
            new Request("https://armada.test/api/v1/sandbox/launch", {
              method: "POST",
              headers: { authorization: `Bearer ${service}` },
              body: JSON.stringify({ golden: "web", harness: "claude", ...body }),
            }),
            { ...options, providerFor: () => boat.provider },
          );
        if (repo !== undefined) {
          for (const invalid of ["bad", "https://github.com/acme/web", "", 42, null, ["acme/web"]]) {
            expect((await launch({ repo: invalid }))?.status).toBe(400);
            expect(boat.forks).toHaveLength(0);
          }
          const unknown = await launch({ repo: "acme/missing" });
          expect(unknown?.status).toBe(404);
          expect(boat.forks).toHaveLength(0);
          expect(boat.preparations).toEqual([]);
        }
        const response = await launch(repo === undefined ? {} : { repo });
        if (!response) throw new Error("missing response");
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text).sandbox).toMatchObject({
          provider: "boat",
          boatId: "bx_1",
          providerSandboxId: "bx_1",
        });
        expect(boat.forks).toHaveLength(1);
        expect((await db.query("select provider_sandbox_id from sandboxes")).rows).toEqual([
          { provider_sandbox_id: "bx_1" },
        ]);
        expect(boat.preparations).toEqual(
          repo === undefined ? [] : [{ sandboxId: "bx_1", harness: "claude", cwd: "/home/user/web" }],
        );
        expect(text).not.toContain("server-only-boat-key");
        expect(text).not.toContain("server-only-model-token");
      });
    });
  }

  test("sandbox/launch refuses a service token scoped to another org", async () => {
    await withServer(async ({ db, options }) => {
      const orgA = (await options.store.createOrg("A", STAN)).id;
      const orgB = (await options.store.createOrg("B", STAN)).id;
      options.authStore.addMembership(STAN, { orgId: orgA, name: "A", role: "admin" });
      await db.query(
        "insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values ($1, 'web', 'org', $2, $3, $4::jsonb)",
        [
          orgB,
          STAN,
          `a${"b".repeat(62)}`,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const service = generateToken("service");
      await options.authStore.insertToken("service", {
        userId: STAN,
        orgId: orgA,
        hash: await sha256Hex(service),
        label: "ci",
        createdAt: new Date().toISOString(),
      });
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: `Bearer ${service}` },
          body: JSON.stringify({ golden: "web", org: orgB, harness: "claude" }),
        }),
        options,
      );
      expect(response?.status).toBe(403);
    });
  });

  test("golden/capabilities authenticates and denies foreign orgs before credential metadata reads", async () => {
    await withServer(async ({ db, options }) => {
      const orgA = (await options.store.createOrg("Capabilities A", STAN)).id;
      const orgB = (await options.store.createOrg("Capabilities B", STAN)).id;
      options.authStore.addMembership(STAN, { orgId: orgA, name: "Capabilities A", role: "admin" });
      options.authStore.addMembership(STAN, { orgId: orgB, name: "Capabilities B", role: "admin" });
      const service = generateToken("service");
      await options.authStore.insertToken("service", {
        userId: STAN,
        orgId: orgA,
        hash: await sha256Hex(service),
        label: "capabilities",
        createdAt: new Date().toISOString(),
      });
      await options.store.setOrgBoatKey(orgA, await encryptSecret("capability-org-a", KEY));
      await options.store.setOrgBoatKey(orgB, await encryptSecret("capability-org-b", KEY));
      const targets: unknown[] = [];
      let secretReads = 0;
      let maxGoldens: number | undefined = 9;
      options.providers = {
        resolve: async () => {
          throw new Error("Metadata must not resolve resources.");
        },
      };
      options.providerMetadata = createProviderMetadata({
        sql: db,
        vault: {
          credentials: async (...args) => {
            secretReads++;
            return options.store.credentials(...args);
          },
          orgBoatKey: async (...args) => {
            secretReads++;
            return options.store.orgBoatKey(...args);
          },
        },
        encryptionKey: KEY,
        providerFor: (key, caller) => {
          targets.push({ key, userId: caller?.userId });
          return { ...fakeBoat().provider, ...(maxGoldens === undefined ? {} : { maxGoldens }) };
        },
      });
      const request = (authorization: string, body: object) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/golden/capabilities", {
            method: "POST",
            headers: { authorization },
            body: JSON.stringify(body),
          }),
          options,
        );
      expect((await request("", { org: orgA }))?.status).toBe(401);
      expect((await request(`Bearer ${service}`, { org: orgB }))?.status).toBe(403);
      const session = (id: string) =>
        `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: id })).replace(/=+$/, "")}.sig`;
      expect((await request(session(ADA), { org: orgA }))?.status).toBe(403);
      expect(targets).toEqual([]);
      expect(secretReads).toBe(0);
      const result = await request(`Bearer ${service}`, { org: orgA, provider: "boat" });
      expect(result?.status).toBe(200);
      expect(result?.headers.get("cache-control")).toBe("no-store");
      expect(await result?.json()).toEqual({ provider: "boat", maxGoldens: 9, bindings: [] });
      maxGoldens = undefined;
      expect(await (await request(`Bearer ${service}`, {}))?.json()).toEqual({ provider: "boat", maxGoldens: null });
      expect(await (await request(session(STAN), { org: orgB, provider: "boat" }))?.json()).toEqual({
        provider: "boat",
        maxGoldens: null,
      });
      expect(targets).toEqual([
        { key: "capability-org-a", userId: STAN },
        { key: "capability-org-a", userId: STAN },
        { key: "capability-org-b", userId: STAN },
      ]);
      expect((await request(`Bearer ${service}`, { provider: "invalid" }))?.status).toBe(400);
      expect(targets).toHaveLength(3);
      const reads = secretReads;
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [orgA, ADA]);
      await db.query("delete from members where org_id=$1 and user_id=$2", [orgA, STAN]);
      expect((await request(`Bearer ${service}`, { org: orgA }))?.status).toBe(403);
      expect(secretReads).toBe(reads);
    });
  });

  test("golden/list uses MCP visibility rules and service-token org scope", async () => {
    await withServer(async ({ db, options }) => {
      const orgA = (await options.store.createOrg("A", STAN)).id;
      const orgB = (await options.store.createOrg("B", STAN)).id;
      await db.query("insert into members (org_id, user_id, role) values ($1, $2, 'member')", [orgA, ADA]);
      options.authStore.addMembership(ADA, { orgId: orgA, name: "A", role: "member" });
      const config = JSON.stringify({
        repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }],
        init: [],
      });
      await db.query(
        `insert into goldens (org_id, name, visibility, owner_id, config) values
         ($1, 'shared', 'org', $2, $3::jsonb), ($1, 'stan-private', 'private', $2, $3::jsonb),
         ($1, 'ada-private', 'private', $4, $3::jsonb), ($5, 'other-org', 'org', $2, $3::jsonb)`,
        [orgA, STAN, config, ADA, orgB],
      );
      const session = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: ADA })).replace(/=+$/, "")}.sig`;
      const list = (authorization: string) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/golden/list", { method: "POST", headers: { authorization } }),
          options,
        );
      const sessionResponse = await list(`Bearer ${session}`);
      if (!sessionResponse) throw new Error("missing response");
      expect(sessionResponse.status).toBe(200);
      expect(
        ((await sessionResponse.json()) as { goldens: { name: string }[] }).goldens.map((golden) => golden.name),
      ).toEqual(["ada-private", "shared"]);
      const service = generateToken("service");
      options.authStore.addMembership(STAN, { orgId: orgA, name: "A", role: "admin" });
      await options.authStore.insertToken("service", {
        userId: STAN,
        orgId: orgA,
        hash: await sha256Hex(service),
        label: "ci",
        createdAt: new Date().toISOString(),
      });
      const serviceResponse = await list(`Bearer ${service}`);
      if (!serviceResponse) throw new Error("missing response");
      expect(serviceResponse.status).toBe(200);
      expect(
        ((await serviceResponse.json()) as { goldens: { name: string }[] }).goldens.map((golden) => golden.name),
      ).toEqual(["shared", "stan-private"]);
      expect((await list(""))?.status).toBe(401);
    });
  });

  test("accepts a service token but keeps it scoped to its verified org", async () => {
    await withServer(async ({ options }) => {
      await options.store.createOrg("A", STAN);
      const orgs = await options.store.memberships(STAN);
      const actualA = orgs[0]?.id;
      if (!actualA) throw new Error("missing org");
      await options.store.createOrg("B", STAN);
      const actualB = (await options.store.memberships(STAN)).find((org) => org.id !== actualA)?.id;
      if (!actualB) throw new Error("missing second org");
      const service = generateToken("service");
      options.authStore.addMembership(STAN, { orgId: actualA, name: "A", role: "admin" });
      await options.authStore.insertToken("service", {
        userId: STAN,
        orgId: actualA,
        hash: await sha256Hex(service),
        label: "ci",
        createdAt: new Date().toISOString(),
      });
      const call = (body: object, route = "creds/list") =>
        handleControlRequest(
          new Request(`https://armada.test/api/v1/${route}`, {
            method: "POST",
            headers: { authorization: `Bearer ${service}` },
            body: JSON.stringify(body),
          }),
          options,
        );
      expect((await call({ org: actualA }))?.status).toBe(200);
      expect((await call({ org: actualB }))?.status).toBe(403);
      expect((await call({ org: actualB }, "mcp/list"))?.status).toBe(403);
      expect((await call({ state: "one-use-state", code: "one-use-code" }, "mcp/oauth/callback"))?.status).toBe(403);
    });
  });

  test("does not trust a user id supplied in a control body", async () => {
    await withServer(async ({ options }) => {
      const headers = {
        authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
      };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/org/create", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Caller only", userId: ADA }),
        }),
        options,
      );
      expect(response?.status).toBe(200);
      expect((await options.store.memberships(STAN)).map((org) => org.name)).toContain("Caller only");
      expect((await options.store.memberships(ADA)).map((org) => org.name)).not.toContain("Caller only");
    });
  });

  test("without an encryption key a credential is refused and nothing is stored", async () => {
    await withServer(async ({ options }) => {
      const headers = {
        authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
      };
      const keyless: ControlOptions = { ...options, encryptionKey: undefined };
      const send = (route: string, body: object) =>
        handleControlRequest(
          new Request(`https://armada.test/api/v1/${route}`, { method: "POST", headers, body: JSON.stringify(body) }),
          keyless,
        );
      await send("org/create", { name: "Vibe" });
      const response = await send("creds/set", { scope: "user", kind: "openai", value: "sk-leaky-value" });
      expect(response?.status).toBe(503);
      const text = await response?.text();
      expect(text).toContain("ARMADA_ENCRYPTION_KEY");
      expect(text).not.toContain("sk-leaky-value");
      expect(await options.store.listCredentials("user", STAN)).toEqual([]);
    });
  });
});

interface Result {
  code: number;
  out: string;
  err: string;
}

interface Who {
  out: string;
  err: string;
  run(argv: string[], input?: { stdin?: string | null; files?: Record<string, string> }): Promise<Result>;
}

function fakeProvider() {
  return {
    id: "boat",
    harnesses: ["claude", "codex"],
    capabilities: { claude: { reasoningEffort: true }, codex: { reasoningEffort: true } } as never,
    async fork() {
      return {
        id: "bx_launch",
        name: "web",
        state: "running",
        desktopAvailable: false,
        snapshotAvailable: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        archiveAfter: "2026-01-01T01:00:00.000Z",
        labels: {},
      };
    },
    async prompt() {
      return { promptId: "prompt", conversationId: "conversation" };
    },
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, detached: false };
    },
    async get() {
      return {
        id: "bx_launch",
        name: "web",
        state: "running",
        desktopAvailable: false,
        snapshotAvailable: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        archiveAfter: "2026-01-01T01:00:00.000Z",
        labels: {},
      };
    },
  } as never;
}

async function withServer(
  body: (ctx: {
    db: PGlite;
    options: ControlOptions & { store: VaultStore; authStore: ReturnType<typeof createMemoryAuthStore> };
    cli: (userId: string, opts?: { session?: boolean; armadaUrl?: boolean; token?: string }) => Who;
  }) => Promise<void>,
): Promise<void> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await db.query("insert into auth.users (id, email) values ($1, 'stan@example.com'), ($2, 'ada@example.com')", [
      STAN,
      ADA,
    ]);
    const supabase = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const authorization =
        input instanceof Request
          ? (input.headers.get("authorization") ?? "")
          : (new Headers(init?.headers).get("authorization") ?? "");
      const token = authorization.replace(/^Bearer /, "");
      const payload = token.split(".")[1];
      let id: unknown;
      try {
        id = payload ? JSON.parse(atob(payload))?.sub : undefined;
      } catch {
        id = undefined;
      }
      if (url.hostname === "supabase.test" && url.pathname === "/auth/v1/user" && typeof id === "string") {
        return Response.json({ id });
      }
      return new Response("{}", { status: 401 });
    };
    const authStore = createMemoryAuthStore();
    const options = {
      authStore,
      supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon", fetch: supabase },
      store: createSqlVaultStore(db),
      encryptionKey: KEY,
      data: createSqlData(db),
      credentialBindingRecovery: createCredentialBindingRecovery(db, KEY),
    };
    const cli = (userId: string, opts: { session?: boolean; armadaUrl?: boolean; token?: string } = {}): Who => {
      const who: Who = {
        out: "",
        err: "",
        async run(argv, input = {}) {
          let out = "";
          let err = "";
          const files = input.files ?? {};
          const auth: AuthIo = {
            out: (text) => (out += text),
            err: (text) => (err += text),
            env: {
              ...(opts.armadaUrl === false
                ? { ARMADA_URL: "https://missing.armada.test" }
                : { ARMADA_URL: "https://armada.test" }),
            },
            fetch: async (input, init) => {
              const request = input instanceof Request ? input : new Request(input.toString(), init);
              if (new URL(request.url).hostname === "armada.test") {
                return (await handleControlRequest(request, options)) ?? new Response("{}", { status: 404 });
              }
              throw new Error("unexpected host");
            },
            now: () => new Date("2026-11-08T00:00:00.000Z"),
            open: () => undefined,
            session: memorySessionStore(
              opts.session === false
                ? null
                : {
                    accessToken:
                      opts.token ??
                      `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`,
                    refreshToken: "refresh",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    supabaseUrl: "https://supabase.test",
                    userId,
                  },
            ),
          };
          const code = await run(
            argv,
            { out: auth.out, err: auth.err },
            {
              auth,
              readFile: async (path) => {
                const content = files[path];
                if (content === undefined) throw new Error("missing");
                return content;
              },
              readStdin: async () => {
                if (input.stdin === undefined || input.stdin === null) throw new Error("stdin is a terminal");
                return input.stdin;
              },
            },
          );
          who.out += out;
          who.err += err;
          return { code, out, err };
        },
      };
      return who;
    };
    await body({ db, options, cli });
  } finally {
    await db.close();
  }
}

describe("controlOptionsFromEnv", () => {
  test("wires golden/create and the control API's database to the same transaction-capable adapter armada serve uses", () => {
    // Bun.SQL connects lazily, so a URL nothing is listening on still constructs without a live database.
    const options = controlOptionsFromEnv({
      ARMADA_DATABASE_URL: "postgres://armada:armada@127.0.0.1:1/armada_test_unreachable",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      ARMADA_ENCRYPTION_KEY: KEY,
    });
    expect(options.goldenBuilds).toBeDefined();
    expect(options.providerFor).toBeDefined();
    expect(typeof options.credentialBindingRecovery).toBe("function");
    expect(typeof options.providerFor?.("any-key").exec).toBe("function");
  });

  test("requires every variable it needs", () => {
    expect(() => controlOptionsFromEnv({})).toThrow("ARMADA_DATABASE_URL");
  });
});

test("CLI removal uses authorized API and returns only the retained-artifact receipt", async () => {
  await withServer(async ({ db, options, cli }) => {
    const stan = cli(STAN);
    await stan.run(["org", "create", "Removal"]);
    const org = (await options.store.memberships(STAN))[0]!;
    options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
    const result = await db.query<{ id: string }>(
      "insert into goldens(org_id,owner_id,name,visibility,config) values($1,$2,'remove-me','org',$3::jsonb) returning id",
      [
        org.id,
        STAN,
        JSON.stringify({ repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] }),
      ],
    );
    const id = result.rows[0]!.id;
    const removed = await stan.run(["golden", "remove", id, "--org", org.id, "--json"]);
    expect(removed).toMatchObject({ code: 0 });
    expect(JSON.parse(removed.out)).toEqual({ id, removedAt: expect.any(String), artifacts: "retained" });
    expect((await stan.run(["golden", "list", "--json"])).out).not.toContain("remove-me");
    const unauthenticated = await handleControlRequest(
      new Request("http://armada.test/api/v1/golden/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }),
      options,
    );
    expect(unauthenticated?.status).toBe(401);
  });
});

test("public sandbox logs omit account-private native quota and auth records", async () => {
  await withServer(async ({ options, cli }) => {
    const stan = cli(STAN);
    await stan.run(["org", "create", "Quota privacy"]);
    const boat = fakeBoat();
    boat.provider.get = async (id) => ({ id, name: id, state: "ready", providerState: "ready", labels: {} });
    const types = [
      "usage_report",
      "rate_limit_event",
      "account/rateLimits/updated",
      "account/rateLimits/read",
      "account/updated",
      "auth_status",
    ];
    boat.provider.events = async () => ({
      events: [
        ...types.map((type) => ({
          id: type,
          at: 1,
          kind: "other" as const,
          type,
          data: { private: "personal-subscription-information" },
        })),
        {
          id: "local",
          at: 1,
          kind: "other" as const,
          type: "system",
          data: { subtype: "local_command_output", content: "personal-subscription-information" },
        },
        {
          id: "ordinary-system",
          at: 1,
          kind: "other" as const,
          type: "system",
          data: { subtype: "init", public: "ordinary-native-init" },
        },
        { id: "message", at: 2, kind: "message" as const, text: "public work", partial: false, tools: [] },
      ],
      hasMore: false,
    });
    options.logs = async () => ({ provider: boat.provider, providerSandboxId: "bx_1" });
    const result = await stan.run(["logs", STAN, "--json"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("public work");
    expect(result.out).toContain("ordinary-native-init");
    expect(result.out).not.toContain("personal-subscription-information");
    for (const type of types) expect(result.out).not.toContain(type);
  });
});

test("CLI named-account operations preserve safe IDs and CAS through the authenticated API", async () => {
  await withServer(async ({ cli }) => {
    const admin = cli(STAN);
    await admin.run(["org", "create", "Accounts"]);
    expect((await admin.run(["creds", "set", "openai", "--name", "Work"], { stdin: "work-test-key" })).code).toBe(0);
    expect(
      (await admin.run(["creds", "set", "openai", "--name", "Personal"], { stdin: "personal-test-key" })).code,
    ).toBe(0);
    const listed = await admin.run(["creds", "list", "--json"]);
    expect(listed.out).not.toContain("work-test-key");
    expect(listed.out).not.toContain("valueEnc");
    const accounts = JSON.parse(listed.out).user;
    expect(accounts).toHaveLength(2);
    const id = accounts.find((row: { name: string }) => row.name === "Work").id;
    expect((await admin.run(["creds", "rename", id, "Renamed"])).code).toBe(0);
    expect((await admin.run(["creds", "default", id])).code).toBe(0);
    expect(
      (await admin.run(["creds", "set", "openai", "--id", id, "--expected-version", "1"], { stdin: "new-test-key" }))
        .code,
    ).toBe(0);
    expect(
      (await admin.run(["creds", "set", "openai", "--id", id, "--expected-version", "1"], { stdin: "stale-test-key" }))
        .code,
    ).not.toBe(0);
    expect((await admin.run(["creds", "remove", id])).code).toBe(0);
    expect(JSON.parse((await admin.run(["creds", "list", "--json"])).out).user).toHaveLength(1);
  });
});

test.each(["claude", "codex"] as const)(
  "owner explicitly recovers a stopped legacy Modal %s binding once, retaining its workspace and conversations",
  async (harness) => {
    await withServer(async ({ db, options, cli }) => {
      const admin = cli(STAN),
        owner = cli(ADA);
      await admin.run(["org", "create", "Recovery"]);
      const org = (await options.store.memberships(STAN))[0]!;
      await options.store.addMember(org.id, ADA, "member");
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      options.authStore.addMembership(ADA, { orgId: org.id, name: org.name, role: "member" });
      const golden = (
        await db.query<{ id: string }>(
          "insert into goldens(org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config) values($1,$2,'legacy','org','modal','im-golden','ws','main','ap-retained',$3::jsonb) returning id",
          [
            org.id,
            ADA,
            JSON.stringify({ repos: [{ url: "https://github.com/acme/web", branch: "main", dir: "web" }], init: [] }),
          ],
        )
      ).rows[0]!.id;
      const id = crypto.randomUUID(),
        machineId = "modal_legacy_retained";
      await db.query(
        "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,stopped_at,conversation_ids) values($1,'modal',$2,$3,$4,$5, $6,'stopped',now(),ARRAY['existing-conversation'])",
        [id, machineId, golden, org.id, ADA, harness],
      );
      const scope: Scope = {
        orgId: org.id,
        userId: ADA,
        visibility: "org",
        binding: { workspace: "ws", environment: "main", appId: "ap-retained" },
      };
      const key = scopeKey(scope);
      const machine: Machine = {
        info: {
          id: machineId,
          name: "Existing work",
          state: "stopped",
          providerState: "stopped",
          labels: { retained: "yes" },
        },
        generation: 4,
        golden: false,
        phase: "stopped",
        physicalId: "sb-existing-stopped",
        physicalName: "existing-workspace",
        recoveryImageId: "im-existing-work",
        ttlSeconds: 14400,
      };
      await db.query("insert into modal_server_scopes(scope,context) values($1,$2::jsonb)", [
        key,
        JSON.stringify(scope),
      ]);
      await db.query(
        "insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record) values($1,$2,$3,'org',$4,'existing',$5::jsonb)",
        [key, org.id, ADA, machineId, JSON.stringify(machine)],
      );
      await db.query("insert into modal_server_harnesses(scope,machine_id,harness) values($1,$2,$3)", [
        key,
        machineId,
        harness,
      ]);
      const nativeToken = (name: string) =>
        JSON.stringify({
          tokens: { access_token: name + "-access", refresh_token: name + "-refresh", account_id: "synthetic-account" },
        });
      for (const [name, value] of [
        ["Chosen", "chosen-token"],
        ["Alternate", "alternate-token"],
      ])
        expect(
          (
            await owner.run(["creds", "set", harness === "claude" ? "claude-oauth" : "codex-auth", "--name", name!], {
              stdin: harness === "claude" ? value! : nativeToken(value!),
            })
          ).code,
        ).toBe(0);
      await owner.run(["creds", "set", harness === "claude" ? "openai" : "claude-oauth", "--name", "WrongHarness"], {
        stdin: "wrong-harness-key",
      });
      const accounts = JSON.parse((await owner.run(["creds", "list", "--json"])).out).user as {
        id: string;
        name: string;
      }[];
      const chosen = accounts.find((row) => row.name === "Chosen")!.id,
        alternate = accounts.find((row) => row.name === "Alternate")!.id,
        wrong = accounts.find((row) => row.name === "WrongHarness")!.id;
      const post = async (
        userId: string,
        credentialId: string,
        action = "bind-credential",
        extra: Record<string, unknown> = {},
      ) => {
        const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`;
        return (await handleControlRequest(
          new Request(`https://armada.test/api/v1/sandbox/${action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({
              id,
              org: org.id,
              ...(action === "bind-credential" ? { credentialId } : {}),
              ...extra,
            }),
          }),
          options,
        ))!;
      };
      const modelAuth = createModelAuthOwnership(db, KEY);
      const resolver = modalLaunchEnvironment({
        modelAuth,
        sql: db,
        vault: options.store,
        encryptionKey: KEY,
        scope,
        scopeKey: key,
        callerUserId: ADA,
      });
      await expect(resolver(machine, {})).rejects.toMatchObject({ code: "credential_binding_required" });
      let providerResolutions = 0;
      options.providers = {
        resolve: async () => {
          providerResolutions++;
          throw new Error("Unbound operations must not reach provider construction.");
        },
      };
      for (const [action, extra] of [
        ["send", { prompt: "continue" }],
        ["exec", { command: "pwd" }],
        ["steer", { text: "pause" }],
        ["interrupt", {}],
      ] as const) {
        const refused = await post(ADA, chosen, action, extra);
        expect(refused.status).toBe(409);
        // The refusal names the owner's recovery route instead of leaving the caller without a way out.
        expect(await refused.json()).toMatchObject({
          error: { code: "credential_binding_required", message: expect.stringContaining("armada bind-credential") },
        });
      }
      expect(providerResolutions).toBe(0);
      expect(
        (
          await db.query<{ record: Machine }>("select record from modal_machines where scope=$1 and id=$2", [
            key,
            machineId,
          ])
        ).rows[0]!.record,
      ).toEqual(machine);
      expect((await post(STAN, chosen)).status).toBe(404); // Org admins cannot adopt another owner's workspace.
      const incompatible = await post(ADA, wrong);
      expect(await incompatible.json()).toMatchObject({
        error: { code: "credential_refused", message: expect.stringContaining("incompatible") },
      });
      expect(incompatible.status).toBe(422);
      await options.store.removeMember(org.id, ADA);
      expect((await post(ADA, chosen)).status).toBe(404); // The named org is resolved against fresh memberships.
      // Without --org, the bearer's org list may be stale: the transaction checks membership again.
      expect((await post(ADA, chosen, "bind-credential", { org: undefined })).status).toBe(403);
      await options.store.addMember(org.id, ADA, "member");
      for (const phase of ["active", "checkpoint", "snapshot", "terminate"]) {
        await db.query("update modal_machines set record=$3::jsonb where scope=$1 and id=$2", [
          key,
          machineId,
          JSON.stringify({ ...machine, phase }),
        ]);
        const unsafe = await post(ADA, chosen);
        expect(unsafe.status).toBe(409);
        expect(await unsafe.json()).toMatchObject({ error: { code: "credential_binding_unsafe" } });
      }
      await db.query(
        "update modal_machines set record=$3::jsonb,lease_id=$4,lease_until=now()+interval '1 minute' where scope=$1 and id=$2",
        [key, machineId, JSON.stringify(machine), crypto.randomUUID()],
      );
      expect((await post(ADA, chosen)).status).toBe(409);
      await db.query("update modal_machines set lease_id=null,lease_until=null where scope=$1 and id=$2", [
        key,
        machineId,
      ]);
      await db.query("update sandboxes set activity_lease_id=$2,activity_until=now()+interval '1 minute' where id=$1", [
        id,
        crypto.randomUUID(),
      ]);
      expect((await post(ADA, chosen)).status).toBe(409);
      // Expired leases are released everywhere else; a failed send or a reconciler stop can leave them behind.
      await db.query("update modal_machines set lease_until=now()-interval '1 minute' where scope=$1 and id=$2", [
        key,
        machineId,
      ]);
      await db.query(
        "update sandboxes set activity_lease_id=$2,activity_until=now()-interval '1 minute',reconcile_lease=$3,reconcile_lease_until=now()-interval '1 minute' where id=$1",
        [id, crypto.randomUUID(), crypto.randomUUID()],
      );
      const attempts = await Promise.all([
        owner.run(["bind-credential", id, "--credential-id", chosen, "--org", org.id, "--json"]),
        owner.run(["bind-credential", id, "--credential-id", alternate, "--org", "Recovery", "--json"]),
      ]);
      expect(attempts.map((result) => result.code).sort()).toEqual([0, 1]);
      // The loser lost the compare-and-swap; it was not refused for its org name.
      expect(attempts.find((result) => result.code === 1)!.err).toContain("bound");
      const winner = JSON.parse(attempts.find((result) => result.code === 0)!.out);
      expect([chosen, alternate]).toContain(winner.credentialId);
      expect(winner).toMatchObject({ id, credentialVersion: 1, harness, status: "bound" });
      expect(JSON.stringify(attempts)).not.toContain("chosen-token");
      expect(
        (await db.query("select credential_id,credential_version,conversation_ids from sandboxes where id=$1", [id]))
          .rows[0],
      ).toEqual({
        credential_id: winner.credentialId,
        credential_version: 1,
        conversation_ids: ["existing-conversation"],
      });
      expect(
        (
          await db.query(
            "select credential_id,credential_version from modal_server_harnesses where scope=$1 and machine_id=$2",
            [key, machineId],
          )
        ).rows[0],
      ).toEqual({ credential_id: winner.credentialId, credential_version: 1 });
      const after = (
        await db.query<{ record: Machine }>("select record from modal_machines where scope=$1 and id=$2", [
          key,
          machineId,
        ])
      ).rows[0]!.record;
      expect(after.info.labels.sandbox).toBe(id);
      expect({ ...after, info: { ...after.info, labels: machine.info.labels } }).toEqual({
        ...machine,
        launchUserId: ADA,
      });
      expect((await db.query("select count(*)::int as n from modal_machines")).rows[0]).toEqual({ n: 1 });
      const restored = await resolver({ ...after, generation: 5, phase: "booting" }, {});
      const token = winner.credentialId === chosen ? "chosen-token" : "alternate-token";
      if (harness === "claude") expect(restored.claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
      else {
        expect(restored.codexAuthJson).toBe(nativeToken(token));
        expect(restored.nativeAuthRevision).toBe(0);
        await expect(
          modelAuth.claim({ userId: ADA, orgId: org.id, role: "member" }, winner.credentialId, 1, crypto.randomUUID()),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      expect((await post(ADA, winner.credentialId === chosen ? alternate : chosen)).status).toBe(409);
    });
  },
);
