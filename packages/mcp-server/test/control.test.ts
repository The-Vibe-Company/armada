import { describe, expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, memorySessionStore, sha256Hex } from "@armada/auth";
import {
  DEFAULT_LAUNCH_TTL_SECONDS,
  encryptSecret,
  HARNESS_KINDS,
  HARNESSES,
  type LaunchOptionsResponse,
  MACHINE_SIZES,
  MODEL_CATALOG,
  PROVIDER_LIMITS,
  ProviderError,
  resolveBoatKey,
  resolveCredentials,
  type Sql,
  VaultError,
  type VaultStore,
} from "@armada/core";
import { modalLaunchReceipt, sandboxCheckOperations, skillpackOperations } from "@armada/core/contract";
import { createSqlVaultStore, createTemplateService } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { type ControlOptions, controlOptionsFromEnv, createSqlData, handleControlRequest } from "../src/index.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { withBoatManagementIdentity } from "../src/observed-boat.ts";
import { createProviderMetadata } from "../src/provider-metadata.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { enrolledLaunchPolicy } from "./launch-runtime.fixture.ts";
import { modalAdmissionFixture } from "./modal-admission.fixture.ts";
import { publishedFailure, publishedRequest, publishedResponse } from "./published-response.ts";
import { rowOnlyConnection } from "./row-only-database.ts";
import { bunLikeSql, fakeBoat } from "./support.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");
const STAN = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const TOKEN_SECRET = "claude_private_token";
const AUTH_JSON = '{"tokens":{"access_token":"codex-do-not-leak"}}';
const controlDatabase = rowOnlyConnection();

// The HTTP contract owns classification: the real HTTP handler classifies admission failures.
for (const failure of [
  "credential_refused",
  "provider_unavailable",
  "dependency_unavailable",
  "rate_limited",
  "payment_required",
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
      boat.provider.backendIdentity = async () => {
        throw new ProviderError({
          provider: "boat",
          code: failure === "rate_limited" || failure === "payment_required" ? failure : "unavailable",
          ...(failure === "rate_limited"
            ? {
                status: 429,
                retryAfterSeconds: 120,
                details: {
                  window: "day",
                  nextStartAt: "2026-11-12T08:08:00.000Z",
                  message: "private-upstream-canary",
                },
              }
            : {}),
          message: "credential_refused expired revoked (not a classification input)",
          retryable: true,
          ...(failure === "provider_unavailable" ? { status: 503 } : {}),
        });
      };
      if (failure !== "dependency_unavailable")
        options.admitModalLaunch = await modalAdmissionFixture(
          bunLikeSql(db),
          KEY,
          options.store,
          undefined,
          withBoatManagementIdentity(boat.provider, "org", org.id),
        );
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ provider: "boat", golden: "web", harness: "claude" }),
        }),
        options,
      );
      expect(response?.status).toBe(
        failure === "credential_refused"
          ? 422
          : failure === "provider_unavailable"
            ? 502
            : failure === "rate_limited"
              ? 429
              : failure === "payment_required"
                ? 402
                : 503,
      );
      const payload = await response?.json();
      expect(payload).toMatchObject({ error: { code: failure } });
      if (failure === "rate_limited") {
        expect(payload).toMatchObject({
          error: {
            message: expect.stringContaining("plan start limit per day"),
            details: {
              provider: "boat",
              window: "day",
              nextStartAt: "2026-11-12T08:08:00.000Z",
              retryAfterSeconds: 120,
            },
          },
        });
        expect(JSON.stringify(payload)).not.toContain("private-upstream-canary");
      }
      expect((await db.query("select id from sandboxes")).rows).toEqual([]);
    });
  });
}

test("Skillpack connection reports only visible metadata and never advertises unsupported authorization", async () => {
  await withServer(async ({ options }) => {
    const org = await options.store.createOrg("Skills", STAN);
    await options.store.upsertCredential("user", STAN, "skillpack", await encryptSecret("personal-skill-key", KEY));
    await options.store.upsertCredential("user", STAN, "anthropic", await encryptSecret("other-key", KEY));
    await options.store.upsertCredential("org", org.id, "skillpack", await encryptSecret("org-skill-key", KEY));
    const read = (userId?: string, body = {}) =>
      handleControlRequest(
        new Request("https://armada.test/api/v1/skillpack/connection", {
          method: "POST",
          headers: userId
            ? {
                authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`,
              }
            : {},
          body: JSON.stringify(body),
        }),
        options,
      );
    expect((await read())?.status).toBe(401);
    const result = skillpackOperations.readSkillpackConnection.output.parse(await (await read(STAN))?.json());
    expect(result).toMatchObject({ authorization: { available: false, reason: "delegated_key_flow_unavailable" } });
    expect(result.user.map((row: { kind: string }) => row.kind)).toEqual(["skillpack"]);
    expect(result.orgs.map((row: { id: string }) => row.id)).toEqual([org.id]);
    expect(result.orgs[0]!.credentials.map((row: { kind: string }) => row.kind)).toEqual(["skillpack"]);
    expect(JSON.stringify(result)).not.toContain("skill-key");
    expect(JSON.stringify(result)).not.toContain("value_enc");
    expect(await (await read(ADA))?.json()).toMatchObject({ orgs: [] });
    expect((await read(ADA, { org: org.id }))?.status).toBe(404);
  });
});

describe("armada org and armada account against the control API", () => {
  test("organization setup is org-only, live-authorized, validated and encrypted through CLI/API", async () => {
    await withServer(async ({ db, options, cli }) => {
      const admin = cli(STAN);
      const member = cli(ADA);
      await admin.run(["api", "org/create", JSON.stringify({ name: "Setup" })]);
      const org = (await options.store.memberships(STAN))[0]!;
      await options.store.addMember(org.id, ADA, "member");
      let calls = 0;
      options.providerValidator = async () => {
        calls++;
      };
      await member.run(["account", "add", "boat"], { stdin: "personal-test-value" });
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
        JSON.parse((await member.run(["account", "ls", "--org", org.id, "--json"])).out).orgs[0].credentials,
      ).toEqual([{ kind: "boat", createdAt: null }]);
      expect((await admin.run(["account", "rm", "--kind", "boat", "--org", org.id])).code).toBe(0);
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
      const providerStatus = publishedResponse("org/provider/status", "post", "admin").parse(await implicit?.json());
      expect(providerStatus).toMatchObject({ org: { id: org.id } });
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
      const connected = await post(STAN, "connect", { provider: "boat", value: "first-value" });
      expect(connected.status).toBe(200);
      const connectedStatus = publishedResponse("org/provider/connect", "post", "admin").parse(connected.body);
      expect(connectedStatus).toMatchObject({
        providers: expect.arrayContaining([{ provider: "boat", configured: true }]),
      });
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
      const disconnectedStatus = publishedResponse("org/provider/disconnect", "post", "admin").parse(one.body);
      expect(disconnectedStatus).toMatchObject({ org: { id: org.id, role: "admin" }, ready: true });
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

      expect((await stan.run(["api", "org/create", JSON.stringify({ name: "Vibe" })])).code).toBe(0);
      expect((await stan.run(["org", "list"])).out).toContain("Vibe  admin");
      const added = await stan.run(["api", "members/add", JSON.stringify({ org: "Vibe", email: "Ada@Example.com" })]);
      expect(added.code).toBe(0);
      expect(JSON.parse(added.out)).toMatchObject({ member: { email: "ada@example.com", role: "member" } });
      const members = await stan.run(["api", "members/list", JSON.stringify({ org: "Vibe" })]);
      expect(members.code).toBe(0);
      expect(JSON.parse(members.out).members).toContainEqual(
        expect.objectContaining({ email: "ada@example.com", role: "member" }),
      );

      expect(
        (await stan.run(["account", "add", "claude-oauth", "--org", "Vibe"], { stdin: `${TOKEN_SECRET}\n` })).code,
      ).toBe(0);
      expect((await stan.run(["account", "add", "boat", "--org", "Vibe"], { stdin: "boat-org-key" })).code).toBe(0);
      expect(
        (
          await stan.run(["account", "add", "codex-auth", "--file", "/home/stan/auth.json"], {
            files: { "/home/stan/auth.json": AUTH_JSON },
          })
        ).code,
      ).toBe(0);
      expect((await ada.run(["account", "add", "boat"], { stdin: "boat-ada-key" })).code).toBe(0);

      const adaSees = await ada.run(["account", "ls"]);
      expect(adaSees.out).toContain("You:\n  boat");
      expect(adaSees.out).toContain("Org Vibe (member):\n  boat\n  claude-oauth");
      expect(adaSees.out).not.toContain("codex-auth");
      const denied = await ada.run(["account", "add", "anthropic", "--org", "Vibe"], { stdin: "sk-ant-api03-x" });
      expect(denied.code).toBe(1);
      expect(denied.err).toContain("Only an org admin can do that.");
      expect((await ada.run(["account", "rm", "--kind", "claude-oauth", "--org", "Vibe"])).code).toBe(1);
      const remove = await ada.run([
        "api",
        "members/remove",
        JSON.stringify({ org: "Vibe", email: "stan@example.com" }),
      ]);
      expect(remove.code).toBe(1);
      expect(remove.err).toContain("HTTP 403");

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

      expect((await stan.run(["account", "rm", "--kind", "boat", "--org", "Vibe"])).code).toBe(0);
      expect((await stan.run(["account", "ls", "--org", "Vibe"])).out).not.toContain("  boat");
    });
  });

  test("CLI status defaults to recorded state and --live opts into provider probes", async () => {
    await withServer(async ({ options, cli, db }) => {
      const org = await options.store.createOrg("Fast status", STAN);
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      const golden = crypto.randomUUID(),
        id = crypto.randomUUID();
      await db.query(
        "insert into goldens(id,org_id,name,visibility,owner_id,boat_snapshot_id,config) values($1,$2,'fast','org',$3,$4,$5::jsonb)",
        [golden, org.id, STAN, "a".repeat(63), JSON.stringify({ repos: [], init: [] })],
      );
      const boat = fakeBoat();
      const machine = await boat.provider.fork({ from: "snapshot" });
      await db.query(
        "insert into sandboxes(id,golden_id,org_id,owner_id,provider_sandbox_id,harness,status) values($1,$2,$3,$4,$5,'codex','ready')",
        [id, golden, org.id, STAN, machine.id],
      );
      let probes = 0;
      options.providers = {
        resolve: async () => {
          probes++;
          return boat.provider;
        },
      };
      const stan = cli(STAN);
      const cached = await stan.run(["info", id, "--json"]);
      expect(cached.code).toBe(0);
      expect(JSON.parse(cached.out)).toMatchObject({ id, status: "ready", providerState: null, prompt: null });
      expect(probes).toBe(0);
      const live = await stan.run(["info", id, "--live", "--json"]);
      expect(live.code).toBe(0);
      expect(probes).toBe(1);
      expect((await cli(ADA).run(["info", id])).code).not.toBe(0);
      expect(probes).toBe(1);
    });
  });

  test("CLI sandbox list shares the MCP scoped operation and rejects unavailable registry features", async () => {
    await withServer(async ({ options, cli }) => {
      const stan = cli(STAN);
      await stan.run(["api", "org/create", JSON.stringify({ name: "SandboxScope" })]);
      options.providers = { resolve: async () => fakeProvider() };
      const listed = await stan.run(["ls", "--json"]);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.out)).toEqual({ sandboxes: [] });
      const missing = await stan.run(["info", "33333333-3333-4333-8333-333333333333"]);
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
      await stan.run(["api", "org/create", JSON.stringify({ name: "Vibe" })]);
      const tty = await stan.run(["account", "add", "openai"], { stdin: null });
      expect(tty.code).toBe(2);
      expect(tty.err).toContain("Pipe the value on stdin");
      const extra = await stan.run(["account", "add", "openai", "sk-pasted-on-the-command-line"]);
      expect(extra.code).toBe(2);
      expect(extra.err).not.toContain("sk-pasted");
      const unknown = await stan.run(["account", "add", "not-a-credential"], { stdin: "x" });
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("Unknown credential 'not-a-credential'");
      const spaced = await stan.run(["account", "add", "openai"], { stdin: "sk one two" });
      expect(spaced.code).toBe(2);
      expect(spaced.err).not.toContain("one two");
    });
  });

  test("armada events resolves an Armada id through the authenticated server, without a local boat key", async () => {
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
          armadaUrl: "https://armada.test",
          userId: STAN,
          accessToken: `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          refreshToken: "r",
          expiresAt: "2099-01-01T00:00:00.000Z",
          supabaseUrl: "https://supabase.test",
        }),
      };
      expect(await run(["events", armadaId], { out: auth.out, err: auth.err }, { auth })).toBe(0);
      expect(out).toBe("from server\n");
      expect(err).toBe("");
      expect(calls).toEqual([{ path: "bx_server_only", authorization: "server-resolved" }]);
    });
  });

  test("Modal detail selects stored observations after authorization, not the live provider", async () => {
    await withServer(async ({ options, db }) => {
      const org = await options.store.createOrg("Stored reads", STAN);
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      const golden = crypto.randomUUID(),
        id = crypto.randomUUID();
      await db.query(
        "insert into goldens(id,org_id,name,visibility,owner_id,boat_snapshot_id,config) values($1,$2,'stored','org',$3,$4,$5::jsonb)",
        [golden, org.id, STAN, "a".repeat(63), JSON.stringify({ repos: [], init: [] })],
      );
      const boat = fakeBoat();
      const machine = await boat.provider.fork({ from: "snapshot" });
      await db.query(
        "insert into sandboxes(id,golden_id,org_id,owner_id,provider_sandbox_id,harness,status) values($1,$2,$3,$4,$5,'codex','ready')",
        [id, golden, org.id, STAN, machine.id],
      );
      let storedReads = 0;
      const source = options.data;
      if (!source) throw new Error("Expected database-backed control data");
      const configured: ControlOptions = {
        ...options,
        data: (caller) => {
          const data = source(caller);
          return {
            ...data,
            sandboxes: {
              ...data.sandboxes,
              get: async (key) => {
                const row = await data.sandboxes.get(key);
                return row
                  ? {
                      ...row,
                      provider: "modal",
                      modal: { workspace: "fixture", environment: "main", appId: "ap_fixture" },
                    }
                  : null;
              },
            },
          };
        },
        providers: {
          resolve: async () => {
            throw new Error("Detail must not resolve live compute");
          },
        },
        storedProviderFor: async () => {
          storedReads++;
          return { ...boat.provider, id: "modal" };
        },
      };
      const read = (user: string) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/sandbox/status", {
            method: "POST",
            headers: {
              authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`,
            },
            body: JSON.stringify({ id }),
          }),
          configured,
        );
      const response = await read(STAN);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ id, status: "ready" });
      expect(response?.headers.get("server-timing")).toContain("stored_provider;dur=");
      expect(response?.headers.get("server-timing")).toContain("tool_call;dur=");
      expect(storedReads).toBe(1);
      expect((await read(ADA))?.status).toBe(404);
      expect(storedReads).toBe(1);
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
                if (!follow) throw new Error("History reads must not depend on live compute availability");
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
        const timing = response.headers.get("server-timing") ?? "";
        expect(timing).toMatch(/auth;dur=\d+\.\d{2}/);
        expect(timing).toMatch(/logs_target;dur=\d+\.\d{2}/);
        expect(timing).toMatch(/events;dur=\d+\.\d{2}/);
        expect(timing).toMatch(/dispatch;dur=\d+\.\d{2}/);
        expect(timing.includes("state;dur=")).toBe(follow);
        const page = (await response.json()) as { settled: boolean; source?: string };
        expect(page.settled).toBe(true);
        expect(page.source).toBeUndefined();
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
              return { events: [], cursor: undefined, hasMore: false, source: "armada-runtime" };
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
        source: "armada-runtime",
        hasMore: false,
        settled: true,
      });
    });
  });

  test("the CLI needs a login and a server address", async () => {
    await withServer(async ({ cli }) => {
      const nobody = cli(STAN, { session: false });
      expect((await nobody.run(["org", "list"])).err).toContain("You are not signed in. Run armada login.");
      const lost = cli(STAN, { armadaUrl: false });
      expect((await lost.run(["org", "list"])).err).toContain("Armada could not reach the server.");
      const refused = cli(STAN, { token: "revoked" });
      const result = await refused.run(["org", "list"]);
      expect(result.code).toBe(3);
      expect(result.err).toContain("You are not signed in. Run armada login.");
    });
  });
});

describe("control API", () => {
  test("uncertain retained provider outcomes preserve only recovery metadata", async () => {
    await withServer(async ({ db, options }) => {
      const org = await options.store.createOrg("Provider failure", STAN);
      options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
      await db.query(
        "insert into goldens(org_id, owner_id, name, visibility, config) values($1,$2,'failure','org',$3::jsonb) returning id",
        [
          org.id,
          STAN,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
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
    });
  });

  test("launch/options publishes the server's harness, model, size and TTL catalogs to a signed-in caller", async () => {
    await withServer(async ({ options }) => {
      delete options.launch;
      const call = (init: RequestInit) =>
        handleControlRequest(new Request("https://armada.test/api/v1/launch/options", init), options);
      expect((await call({ method: "POST" }))?.status).toBe(401);
      const headers = {
        authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
      };
      const response = await call({ method: "POST", headers, body: "{}" });
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as LaunchOptionsResponse;
      publishedResponse("launch/options").parse(body);
      expect(body.providers.find((provider) => provider.id === "boat")).toMatchObject({
        enabled: true,
        launchSources: ["golden"],
        harnesses: ["claude", "codex"],
        capabilities: { launch: false },
        unsupportedReasons: { launch: expect.any(String) },
      });
      expect(
        body.harnesses
          .find((harness) => harness.id === "codex")
          ?.models.slice(0, 2)
          .map((model) => model.id),
      ).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);
      expect(body.harnesses.find((harness) => harness.id === "codex")?.defaultModel).toBe("gpt-6.2-sol");
      expect(body.dockerRuntime?.opencodeMcpProofVersion).toBe(0);
      expect(body.boatRuntime.opencodeMcpProofVersion).toBe(0);
      const hiddenDocker = body.providers.find((provider) => provider.id === "docker");
      expect(hiddenDocker).toMatchObject({
        enabled: false,
        capabilities: { launch: false, resume: false, goldens: false },
      });
      // Feature flags alone cannot advertise a normal route before its handler is installed.
      options.docker = { hosts: true, placement: true, normalApi: false };
      const discovery = await call({ method: "POST", headers, body: JSON.stringify({ docker: { normalApi: true } }) });
      const publicOptions = (await discovery?.json()) as LaunchOptionsResponse;
      const docker = publicOptions.providers.find((provider) => provider.id === "docker");
      expect(docker).toMatchObject({
        enabled: true,
        launchSources: ["image"],
        harnesses: [...HARNESSES],
      });
      expect(docker?.capabilities).toMatchObject({
        launch: false,
        stop: false,
        delete: false,
        followupPrompts: false,
        resume: false,
      });
      for (const [capability, supported] of Object.entries(docker?.capabilities ?? {})) {
        if (!supported) expect(docker?.unsupportedReasons[capability as keyof typeof docker.capabilities]).toBeTruthy();
      }
      // Even trusted placement flags cannot claim native proof without installed launch/MCP handlers.
      options.docker = {
        hosts: true,
        placement: true,
        normalApi: true,
        normalLaunch: true,
        normalSend: true,
      };
      const unwired = await call({ method: "POST", headers, body: "{}" });
      const unwiredOptions = (await unwired?.json()) as LaunchOptionsResponse;
      expect(unwiredOptions.dockerRuntime?.opencodeMcpProofVersion).toBe(0);
      expect(body.harnesses.map((harness: { id: string }) => harness.id)).toEqual([...HARNESSES]);
      for (const harness of body.harnesses) {
        const catalog = MODEL_CATALOG[harness.id as keyof typeof MODEL_CATALOG];
        expect(harness.defaultModel).toBe(catalog.defaultModel);
        expect(harness.models).toEqual(catalog.models);
        expect(harness.credentialKinds).toEqual(HARNESS_KINDS[harness.id as keyof typeof HARNESS_KINDS]);
      }
      expect(body.harnesses.find((harness) => harness.id === "claude")?.models).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "claude-fable-5-2" })]),
      );
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
      const retiredLaunchPaths = ["sized", "access", "runtime", "modal-runtime"].map(
        (variant) => `/api/v1/sandbox/${["launch", variant, "v1"].join("-")}`,
      );
      for (const path of ["/api/v1/nope", "/api/v1/launch/resolve", ...retiredLaunchPaths]) {
        const unknown = await call(path, { method: "POST", headers, body: "{}" });
        expect(unknown?.status).toBe(404);
        expect(await unknown?.json()).toEqual({ error: { code: "unknown_route", message: "Unknown route." } });
      }
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{" }))?.status).toBe(400);
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{}" }))?.status).toBe(400);
      const org = await options.store.createOrg("Listed organization", STAN);
      const listed = await call("/api/v1/org/list", { method: "POST", headers });
      expect(listed?.status).toBe(200);
      expect(publishedResponse("org/list", "post", "admin").parse(await listed?.json())).toEqual({
        orgs: [{ ...org, role: "admin" }],
      });
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
      const launchDb = await controlDatabase();
      const runLaunch = async ({ db, options }: Parameters<Parameters<typeof withServer>[0]>[0]) => {
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
        options.admitModalLaunch = await modalAdmissionFixture(
          bunLikeSql(db),
          KEY,
          options.store,
          undefined,
          withBoatManagementIdentity(boat.provider, "org", org),
        );
        const launch = (body: Record<string, unknown>) =>
          handleControlRequest(
            new Request("https://armada.test/api/v1/sandbox/launch", {
              method: "POST",
              headers: { authorization: `Bearer ${service}` },
              body: JSON.stringify({ provider: "boat", golden: "web", harness: "claude", ...body }),
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
        }
        if (repo === undefined) {
          for (const reason of ["helper_missing", "helper_receipt_invalid"]) {
            if (reason === "helper_receipt_invalid")
              await db.query(
                `update goldens set helper_receipt='{"version":"old","digest":"old","protocol":0,"platform":"x86_64","capabilities":[],"snapshotId":"old"}' where name='web'`,
              );
            const refused = await launch({ helperCapabilities: ["diagnose"] });
            expect(refused?.status).toBe(400);
            expect(await refused!.json()).toEqual({
              error: {
                code: "unsupported",
                message: expect.any(String),
                details: { reason, action: "rebuild_golden" },
              },
            });
            expect(boat.forks).toHaveLength(0);
          }
        }
        const response = await launch(repo === undefined ? {} : { repo });
        if (!response) throw new Error("missing response");
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(modalLaunchReceipt.parse(JSON.parse(text)).sandbox.status).toBe("starting");
        expect(boat.forks).toHaveLength(0);
        expect((await db.query("select provider_sandbox_id from sandboxes")).rows).toEqual([
          { provider_sandbox_id: null },
        ]);
        if (repo !== undefined)
          expect((await db.query("select repository_dir from sandboxes")).rows).toEqual([{ repository_dir: "web" }]);
        expect(text).not.toContain("server-only-boat-key");
        expect(text).not.toContain("server-only-model-token");
      };
      try {
        await withServer(runLaunch, launchDb);
      } finally {
        await launchDb.exec("reset role; reset all; set search_path=public");
      }
    });
  }

  test.each(["codex", "antigravity"] as const)("%s refusal precedes opening the Boat provider", async (harness) => {
    await withServer(async ({ db, options }) => {
      const org = (await options.store.createOrg("RuntimeAccount", STAN)).id;
      options.authStore.addMembership(STAN, { orgId: org, name: "RuntimeAccount", role: "admin" });
      await db.query(
        "insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config) values ($1, 'web', 'org', $2, $3, $4::jsonb)",
        [
          org,
          STAN,
          `a${"b".repeat(62)}`,
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const openProvider = (): never => {
        throw Error("An account refusal must precede provider initialization");
      };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify({
            org,
            provider: "boat",
            golden: "web",
            harness,
            idempotencyKey: "unbound-account-launch",
          }),
        }),
        {
          ...options,
          providerFor: openProvider,
          providers: { resolve: async () => openProvider() },
          launch: {
            boatRuntimeDefault: {
              policy: { start: async () => openProvider() },
              provider: async () => openProvider(),
              credentials: {
                async resolve() {
                  return { env: { OPENAI_API_KEY: "fixture_key" }, secrets: [], codexAuthJson: false };
                },
              },
              connections: { async validate() {}, async bind() {} },
            },
          },
        },
      );
      expect(response?.status).toBe(harness === "codex" ? 409 : 400);
      expect(await response?.json()).toMatchObject({
        error:
          harness === "codex"
            ? { code: "credential_binding_required", message: expect.stringContaining("--credential-id") }
            : { message: expect.stringContaining("Unknown agent 'antigravity'") },
      });
    });
  });

  test("sandbox/launch replays one sandbox per idempotencyKey and refuses a changed request", async () => {
    await withServer(async ({ db, options }) => {
      const org = (await options.store.createOrg("Keyed", STAN)).id;
      options.authStore.addMembership(STAN, { orgId: org, name: "Keyed", role: "admin" });
      await db.query("update orgs set boat_api_key_enc = $1 where id = $2", [
        await encryptSecret("server-only-boat-key", KEY),
        org,
      ]);
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
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
        ],
      );
      const boat = fakeBoat();
      const provider = { ...boat.provider, managementIdentity: async () => ({ scope: "org" as const, ownerId: org }) };
      options.admitModalLaunch = await modalAdmissionFixture(bunLikeSql(db), KEY, options.store, undefined, provider);
      const keyed = {
        ...options,
        providerFor: () => provider,
        providers: { resolve: async () => provider },
      };
      const call = (route: string, body: Record<string, unknown>, user = STAN) =>
        handleControlRequest(
          new Request(`https://armada.test/api/v1/${route}`, {
            method: "POST",
            headers: {
              authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user })).replace(/=+$/, "")}.sig`,
            },
            body: JSON.stringify({ org, ...body }),
          }),
          keyed,
        );
      const request = {
        provider: "boat",
        golden: "web",
        org: "keyed",
        harness: "claude",
        idempotencyKey: "tender-0001-launch",
        externalRef: "tender:1",
      };
      publishedRequest("sandbox/launch").parse(request);
      const malformed = await call("sandbox/launch", { ...request, ttl_seconds: 60 });
      expect(malformed?.status).toBe(400);
      expect(boat.forks).toHaveLength(0);
      const first = await call("sandbox/launch", request);
      expect(first?.status).toBe(200);
      const body = await first!.json();
      publishedResponse("sandbox/launch").parse(body);
      const { sandbox: launched } = modalLaunchReceipt.parse(body);
      expect(launched.status).toBe("starting");
      const replay = await call("sandbox/launch", request);
      expect(replay?.status).toBe(200);
      expect(await replay!.json()).toEqual(body);
      expect(boat.forks).toHaveLength(0);
      const changed = await call("sandbox/launch", { ...request, externalRef: "tender:2" });
      expect(changed?.status).toBe(409);
      expect(boat.forks).toHaveLength(0);
      const status = await call("sandbox/status", { id: launched.id, recorded: true });
      expect(await status!.json()).toMatchObject({ id: launched.id, externalRef: "tender:1" });
      type Page = { total: number; sandboxes: { id: string; externalRef?: string }[] };
      const list = async (body: Record<string, unknown>, user = STAN) =>
        (await (await call("sandbox/list", body, user))!.json()) as Page;
      const listed = await list({ externalRef: "tender:1" });
      expect(listed.sandboxes.map((row) => [row.id, row.externalRef])).toEqual([[launched.id, "tender:1"]]);
      expect((await list({ externalRef: "tender:2" })).total).toBe(0);
      // A metadata-only member sees the row in an unfiltered list but cannot read or probe its reference.
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, ADA]);
      options.authStore.addMembership(ADA, { orgId: org, name: "Keyed", role: "member" });
      expect((await list({}, ADA)).sandboxes.map((row) => [row.id, row.externalRef])).toEqual([
        [launched.id, undefined],
      ]);
      expect((await list({ externalRef: "tender:1" }, ADA)).total).toBe(0);
    });
  });

  test("REST and MCP refuse the same malformed launch with code invalid", async () => {
    await withServer(async ({ options }) => {
      const org = (await options.store.createOrg("Ref", STAN)).id;
      options.authStore.addMembership(STAN, { orgId: org, name: "Ref", role: "admin" });
      const boat = fakeBoat();
      const caller = { userId: STAN, orgs: [{ orgId: org, role: "admin" as const }], via: "supabase" as const };
      const input = { org, golden: "web", harness: "claude" };
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify(input),
        }),
        { ...options, providerFor: () => boat.provider },
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: { code: "invalid" } });
      await expect(
        callSharedTool(
          {
            caller,
            data: options.data!(caller),
            provider: async () => boat.provider,
            launchCredentials: launchCredentials(options.store, KEY),
            exposedSecrets: async () => [],
            now: () => new Date(),
            sleep: async () => {
              throw Error("No waits");
            },
          },
          "launch",
          input,
        ),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(boat.forks).toHaveLength(0);
    });
  });

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
          body: JSON.stringify({ provider: "boat", golden: "web", org: orgB, harness: "claude" }),
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

  test("golden/list enforces private visibility and service-token org scope", async () => {
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
      const listed = await serviceResponse.json();
      publishedResponse("golden/list").parse(listed);
      expect((listed as { goldens: { name: string }[] }).goldens.map((golden) => golden.name)).toEqual([
        "shared",
        "stan-private",
      ]);
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
      // Names cannot be compared with the UUID-only token scope; give an actionable retry.
      const named = await call({ org: "A" });
      expect(named?.status).toBe(403);
      expect(await named?.json()).toMatchObject({
        error: { message: expect.stringContaining(`--org ${actualA}`) },
      });
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
      const created = publishedResponse("org/create", "post", "admin").parse(await response?.json());
      expect(created).toMatchObject({ org: { name: "Caller only", role: "admin" } });
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
  callerDb?: PGlite,
): Promise<void> {
  // All control cases share one file-owned engine. A supplied connection has
  // already reset its rows; the caller restores any changed session identity.
  const db = callerDb ?? (await controlDatabase());
  try {
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
      launch: { runtime: enrolledLaunchPolicy(db) },
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
                    armadaUrl: opts.armadaUrl === false ? "https://missing.armada.test" : "https://armada.test",
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
    // Restore the session role before its owner reuses or closes the connection.
    await db.exec("reset role");
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
    await stan.run(["api", "org/create", JSON.stringify({ name: "Removal" })]);
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
    const removed = await stan.run(["snapshot", "rm", id, "--org", org.id, "--json"]);
    expect(removed).toMatchObject({ code: 0 });
    expect(JSON.parse(removed.out)).toEqual({ id, removedAt: expect.any(String), artifacts: "retained" });
    const listed = await stan.run(["snapshot", "ls", "--org", org.id, "--json"]);
    expect(listed.code).toBe(0);
    expect(listed.out).not.toContain("remove-me");
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
    await stan.run(["api", "org/create", JSON.stringify({ name: "Quota privacy" })]);
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
    const result = await stan.run(["events", STAN, "--json"]);
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
    await admin.run(["api", "org/create", JSON.stringify({ name: "Accounts" })]);
    expect((await admin.run(["account", "add", "openai", "--name", "Work"], { stdin: "work-test-key" })).code).toBe(0);
    expect(
      (await admin.run(["account", "add", "openai", "--name", "Personal"], { stdin: "personal-test-key" })).code,
    ).toBe(0);
    const listed = await admin.run(["account", "ls", "--json"]);
    expect(listed.out).not.toContain("work-test-key");
    expect(listed.out).not.toContain("valueEnc");
    const accounts = JSON.parse(listed.out).user;
    expect(accounts).toHaveLength(2);
    const id = accounts.find((row: { name: string }) => row.name === "Work").id;
    expect(
      (await admin.run(["api", "creds/accounts/rename", JSON.stringify({ scope: "user", id, name: "Renamed" })])).code,
    ).toBe(0);
    expect((await admin.run(["account", "default", id])).code).toBe(0);
    expect(
      (await admin.run(["account", "add", "openai", "--id", id, "--expected-version", "1"], { stdin: "new-test-key" }))
        .code,
    ).toBe(0);
    expect(
      (
        await admin.run(["account", "add", "openai", "--id", id, "--expected-version", "1"], {
          stdin: "stale-test-key",
        })
      ).code,
    ).not.toBe(0);
    expect((await admin.run(["account", "rm", id])).code).toBe(0);
    expect(JSON.parse((await admin.run(["account", "ls", "--json"])).out).user).toHaveLength(1);
  });
});

test("HTTP launch keeps build-5 refusal code and adds the busy account reason", async () => {
  await withServer(async ({ options, db }) => {
    const org = await options.store.createOrg("Busy", STAN);
    options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
    await db.query(
      "insert into goldens(org_id,owner_id,name,visibility,boat_snapshot_id,config) values($1,$2,'busy','org','snapshot',$3::jsonb)",
      [
        org.id,
        STAN,
        JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
      ],
    );
    options.providerFor = () => fakeBoat().provider;
    options.admitModalLaunch = async () => {
      throw new VaultError("credential_busy", "The model account is unavailable. Check its current credentials.");
    };
    const bearer = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`;
    const response = (await handleControlRequest(
      new Request("https://armada.test/api/v1/sandbox/launch", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ org: org.id, provider: "boat", golden: "busy", harness: "codex" }),
      }),
      options,
    ))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        reason: "credential_busy",
        message: "The model account is unavailable. Check its current credentials.",
      },
    });
  });
});

test("CLI/API connection checks require the owner and current bound revision, exposing only closed runtime diagnostics", async () => {
  await withServer(async ({ db, options, cli }) => {
    const owner = cli(STAN),
      other = cli(ADA);
    await owner.run(["api", "org/create", JSON.stringify({ name: "Connection checks" })]);
    const org = (await options.store.memberships(STAN))[0]!;
    await options.store.addMember(org.id, ADA, "admin");
    options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
    options.authStore.addMembership(ADA, { orgId: org.id, name: org.name, role: "admin" });
    const key = crypto.randomUUID();
    expect(
      (
        await owner.run(["account", "add", "openai", "--name", "Foundry"], {
          stdin: JSON.stringify({
            endpoint: { version: 1, baseUrl: "https://example.com/v1" },
            apiKey: key,
            models: ["deployment"],
          }),
        })
      ).code,
    ).toBe(0);
    const account = (
      await db.query<{ id: string }>("select id from credentials where owner_id=$1 and kind='openai'", [STAN])
    ).rows[0]!.id;
    const golden = (
      await db.query<{ id: string }>(
        "insert into goldens(org_id,owner_id,name,visibility,provider,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config) values($1,$2,'probe','org','modal','im-probe','ws','main','ap-probe',$3::jsonb) returning id",
        [org.id, STAN, JSON.stringify({ repos: [], init: [] })],
      )
    ).rows[0]!.id;
    const id = crypto.randomUUID();
    await db.query(
      "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,credential_id,credential_version,conversation_ids) values($1,'modal','modal_probe',$2,$3,$4,'codex','ready',$5,1,ARRAY['preserved-session'])",
      [id, golden, org.id, STAN, account],
    );
    let calls = 0,
      resolutions = 0;
    let receipt: unknown = { ok: false, status: 401, error: "provider_rejected", code: "invalid_api_key" };
    let expectedHarness: "codex" | "opencode" = "codex";
    let expectedProvider: "modal" | "boat" = "modal";
    let expectedSandboxId = "modal_probe";
    let expectedModel = "deployment";
    options.providers = {
      resolve: async () => {
        resolutions++;
        return {
          ...fakeBoat().provider,
          id: expectedProvider,
          get: async () => {
            if (expectedProvider === "boat") throw Error("Boat checks must never read the native host");
            return {
              id: expectedSandboxId,
              name: "probe",
              state: "ready" as const,
              providerState: "ready",
              labels: {},
            };
          },
          testModelConnection: async (request) => {
            calls++;
            const { signal, ...wire } = request;
            expect(wire).toEqual({ sandboxId: expectedSandboxId, harness: expectedHarness, model: expectedModel });
            expect(signal instanceof AbortSignal).toBe(expectedProvider === "boat");
            return receipt as import("@armada/core").ModelConnectionTestResult;
          },
        };
      },
    };
    const args = ["account", "test", id, "--model", "deployment", "--json"];
    const denied = await other.run(args);
    expect(denied.code).not.toBe(0);
    expect(denied.err).toContain("Only the sandbox owner");
    expect(resolutions).toBe(0);
    const rejected = await owner.run(args);
    expect(rejected.code).toBe(1);
    expect(rejected.err).not.toContain(key);
    expect(JSON.parse(rejected.out)).toEqual({
      id,
      ok: false,
      status: 401,
      error: "provider_rejected",
      code: "invalid_api_key",
    });
    expect(rejected.out).not.toContain(key);
    const checkModel = (body: Record<string, unknown>) =>
      handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/test-model-connection", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify(body),
        }),
        options,
      );
    const success = { ok: true, status: 200, error: null, code: null };
    receipt = success;
    const accepted = await checkModel({ id, model: "deployment" });
    expect(accepted?.status).toBe(200);
    expect(sandboxCheckOperations.testSandboxModelConnection.output.parse(await accepted?.json())).toEqual({
      id,
      test: success,
    });
    expect(
      (await db.query<{ conversation_ids: string[] }>("select conversation_ids from sandboxes where id=$1", [id]))
        .rows[0]?.conversation_ids,
    ).toEqual(["preserved-session"]);
    receipt = { ok: false, status: 401, error: "provider_rejected", code: key, message: key };
    const malformed = await owner.run(args);
    expect(malformed.code).not.toBe(0);
    expect(malformed.out + malformed.err).not.toContain(key);
    const before = calls;
    const badFlags = await owner.run(["account", "test", id, "--model", "deployment", "--file", "never-read"]);
    expect(badFlags.code).not.toBe(0);
    expect(badFlags.err).toContain("accept only --model");
    expect(calls).toBe(before);
    const extra = await checkModel({ id, model: "deployment", apiKey: key });
    expect(extra?.status).toBe(400);
    expect(await extra?.text()).not.toContain(key);
    expect(calls).toBe(before);
    expect(
      (
        await owner.run(["account", "add", "openai", "--id", account, "--expected-version", "1"], {
          stdin: JSON.stringify({
            endpoint: { version: 1, baseUrl: "https://example.com/v1" },
            apiKey: crypto.randomUUID(),
            models: ["deployment"],
          }),
        })
      ).code,
    ).toBe(0);
    expect((await owner.run(args)).code).not.toBe(0);
    expect(calls).toBe(before);
    // A standard vendor key has no endpoint metadata, but the same bound runtime can probe it.
    expect(
      (
        await owner.run(["account", "add", "openai", "--id", account, "--expected-version", "2"], {
          stdin: "vendor_key_placeholder",
        })
      ).code,
    ).toBe(0);
    await db.query("update sandboxes set credential_version=3 where id=$1", [id]);
    receipt = { ok: true, status: 200, error: null, code: null };
    expect((await owner.run(args)).code).toBe(0);
    expect(calls).toBe(before + 1);
    const beforeOpenCode = calls;
    expect(
      (
        await owner.run(
          [
            "account",
            "add",
            "opencode",
            "--name",
            "Custom OpenCode",
            "--base-url",
            "https://example.com/v1",
            "--models",
            "chosen",
          ],
          { stdin: "opencode_key_placeholder" },
        )
      ).code,
    ).toBe(0);
    const openCodeAccount = (
      await db.query<{ id: string }>("select id from credentials where owner_id=$1 and kind='opencode'", [STAN])
    ).rows[0]!.id;
    const openCodeSandbox = crypto.randomUUID();
    expectedSandboxId = "modal_probe_opencode";
    await db.query(
      "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,credential_id,credential_version) values($1,'modal',$2,$3,$4,$5,'opencode','ready',$6,1)",
      [openCodeSandbox, expectedSandboxId, golden, org.id, STAN, openCodeAccount],
    );
    expectedHarness = "opencode";
    expectedModel = "armada/chosen";
    receipt = { ok: true, status: 200, error: null, code: null };
    expect((await owner.run(["account", "test", openCodeSandbox, "--model", expectedModel, "--json"])).code).toBe(0);
    expect(calls).toBe(beforeOpenCode + 1);
    const boatGolden = (
      await db.query<{ id: string }>(
        "insert into goldens(org_id,owner_id,name,visibility,provider,provider_snapshot_id,config) values($1,$2,'boat-probe','private','boat','saved-probe',$3::jsonb) returning id",
        [org.id, STAN, JSON.stringify({ repos: [], init: [] })],
      )
    ).rows[0]!.id;
    const boatId = crypto.randomUUID();
    await db.query(
      "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,credential_id,credential_version,boat_runtime,model,reasoning_effort) values($1,'boat','boat_probe',$2,$3,$4,'codex','ready',$5,3,true,'gpt-6.1-sol','medium')",
      [boatId, boatGolden, org.id, STAN, account],
    );
    expectedProvider = "boat";
    expectedSandboxId = "boat_probe";
    expectedHarness = "codex";
    expectedModel = "deployment";
    const boatArgs = ["account", "test", boatId, "--model", expectedModel, "--json"];
    const generation = (
      await db.query<{ lifecycle_generation: number }>("select lifecycle_generation from sandboxes where id=$1", [
        boatId,
      ])
    ).rows[0]!.lifecycle_generation;
    expect((await owner.run(boatArgs)).code).toBe(0);
    expect((await other.run(boatArgs)).code).not.toBe(0);
    expect(
      (
        await db.query<{ lifecycle_generation: number }>("select lifecycle_generation from sandboxes where id=$1", [
          boatId,
        ])
      ).rows[0]?.lifecycle_generation,
    ).toBe(generation);
    const afterBoat = calls;
    const nativeId = crypto.randomUUID();
    await db.query(
      "insert into sandboxes(id,provider,provider_sandbox_id,golden_id,org_id,owner_id,harness,status,credential_id,credential_version) values($1,'boat','native_probe',$2,$3,$4,'codex','ready',$5,3)",
      [nativeId, boatGolden, org.id, STAN, account],
    );
    expect((await owner.run(["account", "test", nativeId, "--model", expectedModel, "--json"])).code).not.toBe(0);
    expect(calls).toBe(afterBoat);
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [boatId]);
    expect((await owner.run(boatArgs)).code).not.toBe(0);
    expect(calls).toBe(afterBoat);
  });
});

test.each(["rest", "explicit", "mcp"] as const)("public %s Modal launch admits before allocating", async (surface) => {
  await withServer(async ({ db, options }) => {
    const org = await options.store.createOrg("Modal admission", STAN);
    options.authStore.addMembership(STAN, { orgId: org.id, name: org.name, role: "admin" });
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2)", [
      STAN,
      await encryptSecret("fixture-model-key", KEY),
    ]);
    const binding = { workspace: "workspace", environment: "main", appId: "app" };
    await db.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
       values($1,$2,'modal-runtime','org','modal','master','image',$3,$4,$5,'{"repos":[{"url":"https://github.com/example/web.git","branch":"main","dir":"web"}],"init":[]}')`,
      [org.id, STAN, binding.workspace, binding.environment, binding.appId],
    );
    const sql: Sql = { query: (q, v) => db.query(q, v), transaction: (work) => db.transaction((tx) => work(tx)) };
    const host = fakeBoat();
    options.admitModalLaunch = await modalAdmissionFixture(
      sql,
      KEY,
      options.store,
      { orgId: org.id, userId: STAN, visibility: "org", binding },
      { ...host.provider, id: "modal" },
    );
    options.providerFor = () => {
      throw Error("Request must not resolve a synchronous provider");
    };
    const body = {
      org: org.id,
      provider: "modal",
      golden: "modal-runtime",
      harness: "codex",
      prompt: "reply",
      idempotencyKey: "modal-admission-probe",
      ...(surface === "explicit" ? { runtimeVersion: 1, modalTransport: "dialout" } : {}),
      ...(surface === "rest" ? { armadaAccessVersion: 1, armadaAccess: { maxActiveChildren: 1 } } : {}),
    };
    const run = async () => {
      if (surface === "mcp") {
        const caller = { userId: STAN, orgs: [{ orgId: org.id, role: "admin" as const }], via: "service" as const };
        return callSharedTool(
          {
            caller,
            data: options.data!(caller),
            admitModalLaunch: options.admitModalLaunch!,
            provider: async () => {
              throw Error("Request must not resolve a synchronous provider");
            },
            launchCredentials: launchCredentials(options.store, KEY),
            exposedSecrets: async () => [],
            now: () => new Date(),
            sleep: async () => {
              throw Error("No waits");
            },
          },
          "launch",
          body,
        );
      }
      const reply = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: {
            authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`,
          },
          body: JSON.stringify(body),
        }),
        options,
      );
      expect(reply?.status).toBe(200);
      const result = await reply?.json();
      publishedResponse("sandbox/launch").parse(result);
      return result;
    };
    if (surface === "rest") options.sandboxArmadaAccess = {} as NonNullable<ControlOptions["sandboxArmadaAccess"]>;
    const result = modalLaunchReceipt.parse(await run());
    expect(result.sandbox.status).toBe("starting");
    await db.query("update credentials set status='revoked' where owner_id=$1 and kind='openai'", [STAN]);
    expect(await run()).toEqual(result);
    expect(host.forks).toHaveLength(0);
    expect(
      (await db.query("select sandbox_id from jobs where kind='launch' and payload_enc is not null")).rows,
    ).toEqual([{ sandbox_id: result.sandbox.id }]);
    expect((await db.query("select sandbox_id from armada_access_parents")).rows).toEqual(
      surface === "rest" ? [{ sandbox_id: result.sandbox.id }] : [],
    );
  });
});

test("pinned Modal launch resolves personal org references and respects scoped tokens", async () => {
  await withServer(async ({ db, options }) => {
    const org = await options.store.createOrg("modal-team", STAN);
    const other = await options.store.createOrg("other-team", STAN);
    for (const member of [org, other])
      options.authStore.addMembership(STAN, { orgId: member.id, name: member.name, role: "admin" });

    const service = generateToken("service");
    await options.authStore.insertToken("service", {
      userId: STAN,
      orgId: org.id,
      hash: await sha256Hex(service),
      label: "ci",
      createdAt: new Date().toISOString(),
    });
    const personal = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`;
    options.templates = createTemplateService({
      query: (query, values) => db.query(query, values),
      transaction: (work) => db.transaction((tx) => work(tx)),
    });
    options.admitModalLaunch = async () => {
      throw Error("Missing template must never reach admission");
    };
    const launch = (token: string, overrides: Record<string, unknown>) =>
      handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            revision: 1,
            idempotencyKey: "pinned-launch-probe",
            provider: "modal",
            harness: "codex",
            runtimeVersion: 1,
            modalTransport: "dialout",
            prompt: "Probe",
            ...overrides,
          }),
        }),
        options,
      );

    const byId = await launch(personal, { org: org.id });
    expect(byId?.status).toBe(404);
    const byName = await launch(personal, { org: org.name });
    expect(byName?.status).toBe(404);
    expect(await byName?.json()).toEqual(await byId?.json());
    expect((await launch(service, {}))?.status).toBe(404);
    expect((await launch(service, { org: other.id }))?.status).toBe(403);
    for (const malformed of [
      { golden: "mixed-source" },
      { ttlSeconds: PROVIDER_LIMITS.modal.maxTtlSeconds + 1 },
      { idempotencyKey: undefined, requestKey: "pinned-launch-probe" },
    ]) {
      const refused = await launch(personal, { org: org.name, ...malformed });
      expect(refused?.status).toBe(400);
      expect(publishedFailure().parse(await refused?.json())).toMatchObject({ error: { code: "invalid" } });
    }
  });
});
