import { describe, expect, test } from "bun:test";
import { createMemoryAuthStore, generateToken, memorySessionStore, sha256Hex } from "@armada/auth";
import { createSqlVaultStore, encryptSecret, resolveBoatKey, resolveCredentials, type VaultStore } from "@armada/core";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { type ControlOptions, controlOptionsFromEnv, createSqlData, handleControlRequest } from "../src/index.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");
const STAN = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const TOKEN_SECRET = "sk-ant-oat01-do-not-leak";
const AUTH_JSON = '{"tokens":{"access_token":"codex-do-not-leak"}}';

describe("armada org and armada creds against the control API", () => {
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
            boatId: "bx_server_only",
            provider: {
              id: "fake",
              harnesses: ["claude", "codex"],
              capabilities: {} as never,
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

  test("logs follow settles for no prompt and each final prompt status", async () => {
    for (const status of [null, "finished", "failed", "interrupted"] as const) {
      await withServer(async ({ options }) => {
        const armadaId = "44444444-4444-4444-8444-444444444444";
        const prompt = status
          ? [{ id: `prompt-${status}`, at: 1, kind: "prompt" as const, promptId: "pr_1", text: "go" }]
          : [];
        const logs: ControlOptions = {
          ...options,
          logs: async () => ({
            boatId: "bx_follow",
            provider: {
              id: "fake",
              harnesses: ["claude", "codex"],
              capabilities: {} as never,
              async events() {
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
            body: JSON.stringify({ id: armadaId, follow: true }),
          }),
          logs,
        );
        expect(response?.status).toBe(200);
        if (!response) throw new Error("expected response");
        expect(((await response.json()) as { settled: boolean }).settled).toBe(true);
      });
    }
  });

  test("logs follow settles when an empty page has no prompt and preserves its cursor", async () => {
    await withServer(async ({ options }) => {
      const logs: ControlOptions = {
        ...options,
        logs: async () => ({
          boatId: "bx_follow",
          provider: {
            id: "fake",
            harnesses: ["claude", "codex"],
            capabilities: {} as never,
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
      expect((await nobody.run(["org", "list"])).err).toContain("Run armada login.");
      const lost = cli(STAN, { armadaUrl: false });
      expect((await lost.run(["org", "list"])).err).toContain("armada login --url");
      const refused = cli(STAN, { token: "revoked" });
      const result = await refused.run(["org", "list"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("Run armada login.");
    });
  });
});

describe("control API", () => {
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
        create: async (_provider: unknown, _actor: unknown, input: unknown) => {
          expect(input).toMatchObject({
            repos: [],
            config: {
              repos: [{ owner: "acme", repo: "web", branch: "feature/login", dir: "frontend" }],
              init: ["pnpm install"],
            },
          });
          return { snapshot: "golden-bx" };
        },
      } as never;
      const session = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: STAN })).replace(/=+$/, "")}.sig`;
      const request = (body: object) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/golden/create", {
            method: "POST",
            headers: { authorization: `Bearer ${session}` },
            body: JSON.stringify(body),
          }),
          { ...options, goldenCreate: service, providerFor: () => ({}) as never },
        );
      const ok = await request({
        name: "web",
        private: true,
        config: {
          repos: [{ url: "https://github.com/acme/web.git", branch: "feature/login", dir: "frontend" }],
          init: ["pnpm install"],
        },
      });
      expect(ok?.status).toBe(200);
      expect(await ok?.json()).toEqual({ name: "web", visibility: "private", snapshot: "golden-bx" });
      const bad = await request({ name: "web", config: { repos: [{ url: "https://evil.example/acme/web.git" }] } });
      expect(bad?.status).toBe(400);
      expect(await bad?.text()).not.toContain("evil.example");
    });
  });

  test("sandbox/launch launches through scoped server credentials and never returns them", async () => {
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
          JSON.stringify({ repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] }),
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
      const response = await handleControlRequest(
        new Request("https://armada.test/api/v1/sandbox/launch", {
          method: "POST",
          headers: { authorization: `Bearer ${service}` },
          body: JSON.stringify({ golden: "web", harness: "claude" }),
        }),
        { ...options, providerFor: () => fakeProvider() },
      );
      if (!response) throw new Error("missing response");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("server-only-boat-key");
      expect(text).not.toContain("server-only-model-token");
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
          body: JSON.stringify({ golden: "web", org: orgB, harness: "claude" }),
        }),
        options,
      );
      expect(response?.status).toBe(403);
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
      const call = (body: object) =>
        handleControlRequest(
          new Request("https://armada.test/api/v1/creds/list", {
            method: "POST",
            headers: { authorization: `Bearer ${service}` },
            body: JSON.stringify(body),
          }),
          options,
        );
      expect((await call({ org: actualA }))?.status).toBe(200);
      expect((await call({ org: actualB }))?.status).toBe(403);
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
    id: "fake",
    harnesses: ["claude", "codex"],
    capabilities: {} as never,
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
              SUPABASE_ANON_KEY: "anon",
              ...(opts.armadaUrl === false ? {} : { ARMADA_URL: "https://armada.test" }),
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
                    userId,
                    accessToken:
                      opts.token ??
                      `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`,
                    refreshToken: "refresh",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    supabaseUrl: "https://supabase.test",
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
    expect(options.goldenCreate).toBeDefined();
    expect(options.providerFor).toBeDefined();
    expect(typeof options.providerFor?.("any-key").exec).toBe("function");
  });

  test("requires every variable it needs", () => {
    expect(() => controlOptionsFromEnv({})).toThrow("ARMADA_DATABASE_URL");
  });
});
