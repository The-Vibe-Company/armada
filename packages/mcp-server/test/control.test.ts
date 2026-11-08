import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import {
  createSqlGoldenStore,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  GOLDEN_ROOT,
  resolveBoatKey,
  resolveCredentials,
  type VaultStore,
} from "@armada/core";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { type ControlOptions, controlOptionsFromEnv, handleControlRequest } from "../src/index.ts";

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

  test("armada launch asks the server, so the user's credential and the org boat key reach the fork", async () => {
    await withServer(async ({ db, options, cli }) => {
      const stan = cli(STAN);
      expect((await stan.run(["org", "create", "Vibe"])).code).toBe(0);
      expect((await stan.run(["creds", "set", "claude-oauth", "--org", "Vibe"], { stdin: TOKEN_SECRET })).code).toBe(0);
      expect((await stan.run(["creds", "set", "boat", "--org", "Vibe"], { stdin: "boat-org-key" })).code).toBe(0);
      expect((await stan.run(["creds", "set", "codex-auth"], { stdin: AUTH_JSON })).code).toBe(0);
      const org = (await options.store.memberships(STAN))[0];
      const snapshot = `a${"b".repeat(62)}`;
      await db.query(
        `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
         values ($1, 'web', 'org', $2, $3, $4::jsonb)`,
        [
          org?.id,
          STAN,
          snapshot,
          JSON.stringify({
            repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
            init: [],
          }),
        ],
      );

      const boat: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
      const launched = await launch(["launch", "web", "--agent", "codex", "go"], db, options, STAN, boat);
      expect(launched.code).toBe(0);
      expect(launched.out).not.toContain("codex-access");
      expect(launched.out).not.toContain("boat-org-key");
      const fork = boat.find((call) => call.method === "POST" && call.path === "/api/v1/sandboxes");
      expect(fork?.body).toMatchObject({ noEnv: true, from: snapshot, env: { ARMADA_CODEX_AUTH_JSON: AUTH_JSON } });
      expect(JSON.stringify(fork?.body)).not.toContain(TOKEN_SECRET);
      expect(fork?.authorization).toBe("Bearer boat-org-key");
      const wrote = boat.find((call) => JSON.stringify(call.body ?? "").includes("auth.json"));
      if (!wrote) throw new Error("the launch never wrote auth.json");
      const command = (wrote.body as { command: string }).command;
      expect(command).toContain(`${GOLDEN_ROOT}/.codex/auth.json`);
      expect(command).not.toContain("codex-do-not-leak");
    });
  });

  test("armada launch carries the user's GitHub identity: token in the fork env, git set up, nothing printed", async () => {
    await withServer(async ({ db, options, cli }) => {
      const stan = cli(STAN);
      await stan.run(["org", "create", "Vibe"]);
      await stan.run(["creds", "set", "claude-oauth", "--org", "Vibe"], { stdin: TOKEN_SECRET });
      await stan.run(["creds", "set", "boat", "--org", "Vibe"], { stdin: "boat-org-key" });
      const org = (await options.store.memberships(STAN))[0];
      await db.query(
        `insert into goldens (org_id, name, visibility, owner_id, boat_snapshot_id, config)
         values ($1, 'web', 'org', $2, $3, $4::jsonb)`,
        [
          org?.id,
          STAN,
          `a${"b".repeat(62)}`,
          JSON.stringify({
            repos: [{ url: "https://github.com/example/web.git", branch: "main", dir: "web" }],
            init: [],
          }),
        ],
      );

      const without: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
      const skipped = await launch(["launch", "web", "--agent", "claude", "go"], db, options, STAN, without);
      expect(skipped.err).toBe("");
      expect(skipped.code).toBe(0);
      expect(skipped.out).toContain("GitHub: not set up.");
      expect(JSON.stringify(without)).not.toContain("GH_TOKEN");

      await db.query("delete from sandboxes");
      await db.query(
        "insert into github_connections (user_id, github_id, login, refresh_token_enc) values ($1, 583231, 'octocat', $2)",
        [STAN, await encryptSecret("ghr_old", KEY)],
      );
      const githubFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) {
          return Response.json({
            access_token: "ghu_0123456789abcdefghijABCDEFGHIJ0123",
            refresh_token: "ghr_new",
            expires_in: 28_800,
            refresh_token_expires_in: 15_811_200,
          });
        }
        return Response.json({ id: 583231, login: "octocat", name: null });
      }) as typeof fetch;
      const withGitHub: ControlOptions = {
        ...options,
        github: { app: { clientId: "Iv1.test", clientSecret: "secret" }, fetch: githubFetch },
      };
      const boat: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
      const launched = await launch(["launch", "web", "--agent", "claude", "go"], db, withGitHub, STAN, boat);
      expect(launched.code).toBe(0);
      expect(launched.out).toContain("GitHub: git and gh act as octocat");
      expect(launched.out + launched.err).not.toContain("ghu_0123456789");
      const fork = boat.find((call) => call.method === "POST" && call.path === "/api/v1/sandboxes");
      expect(fork?.body).toMatchObject({
        noEnv: true,
        env: {
          GH_TOKEN: "ghu_0123456789abcdefghijABCDEFGHIJ0123",
          GITHUB_TOKEN: "ghu_0123456789abcdefghijABCDEFGHIJ0123",
        },
      });
      expect(JSON.stringify(boat.filter((call) => call !== fork))).not.toContain("ghu_0123456789");
      const setup = boat.find((call) => JSON.stringify(call.body ?? "").includes("users.noreply.github.com"));
      expect(JSON.stringify(setup?.body)).toContain("583231+octocat@users.noreply.github.com");
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
        logs: async (userId, id) => {
          expect(userId).toBe(STAN);
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
          accessToken: `token-${STAN}`,
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
            headers: { authorization: `Bearer token-${STAN}` },
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
          headers: { authorization: `Bearer token-${STAN}` },
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
      expect((await lost.run(["org", "list"])).err).toContain("Set ARMADA_URL");
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
      const headers = { authorization: `Bearer token-${STAN}` };
      expect((await call("/api/v1/nope", { method: "POST", headers }))?.status).toBe(404);
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{" }))?.status).toBe(400);
      expect((await call("/api/v1/org/create", { method: "POST", headers, body: "{}" }))?.status).toBe(400);
      expect((await call("/api/v1/org/list", { method: "POST", headers }))?.status).toBe(200);
    });
  });

  test("without an encryption key a credential is refused and nothing is stored", async () => {
    await withServer(async ({ options }) => {
      const headers = { authorization: `Bearer token-${STAN}` };
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

const SNAP_READY = {
  id: "bx_1",
  name: "web",
  state: "idle",
  desktopAvailable: false,
  snapshotAvailable: false,
  createdAt: "2026-11-08T12:00:00.000Z",
  archiveAfter: "2026-11-08T16:00:00.000Z",
  labels: { armada: "sandbox" },
};

async function launch(
  argv: string[],
  db: PGlite,
  options: ControlOptions,
  userId: string,
  boat: { method: string; path: string; authorization: string | null; body: unknown }[],
): Promise<Result> {
  let out = "";
  let err = "";
  const auth: AuthIo = {
    out: (text) => (out += text),
    err: (text) => (err += text),
    env: { SUPABASE_ANON_KEY: "anon", ARMADA_URL: "https://armada.test" },
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);
      if (url.hostname === "armada.test")
        return (await handleControlRequest(request, options)) ?? new Response("{}", { status: 404 });
      if (url.hostname === "boat.dev") {
        const text = await request.text();
        const body = text === "" ? undefined : JSON.parse(text);
        boat.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        return boatReply(url.pathname, request.method);
      }
      throw new Error(`unexpected ${url.hostname}`);
    },
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    open: () => undefined,
    session: memorySessionStore({
      userId,
      accessToken: `token-${userId}`,
      refreshToken: "refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      supabaseUrl: "https://supabase.test",
    }),
  };
  const code = await run(
    argv,
    { out: auth.out, err: auth.err },
    {
      auth,
      fetch: auth.fetch as unknown as typeof fetch,
      actor: { userId, orgId: (await options.store.memberships(userId))[0]?.id ?? "", role: "member" },
      store: createSqlGoldenStore(db),
      sandboxes: createSqlSandboxStore(db),
      sleep: async () => {},
      sandboxPolls: 3,
    },
  );
  return { code, out, err };
}

function boatReply(path: string, method: string): Response {
  if (path === "/api/v1/sandboxes" && method === "POST") {
    return Response.json(
      { ok: true, type: "sandbox.created", sandbox: { ...SNAP_READY, state: "provisioning" } },
      { status: 202 },
    );
  }
  if (path.endsWith("/commands")) {
    return Response.json({
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  }
  if (path.endsWith("/prompt")) {
    return Response.json(
      {
        ok: true,
        type: "prompt.queued",
        promptId: "prompt_1",
        conversationId: "conv_1",
        status: "queued",
        promptRun: { id: "prompt_1", promptId: "prompt_1", sandboxId: "bx_1", status: "queued", done: false },
      },
      { status: 202 },
    );
  }
  if (path.startsWith("/api/v1/sandboxes/"))
    return Response.json({ ok: true, type: "sandbox.info", sandbox: SNAP_READY });
  throw new Error(`unexpected ${method} ${path}`);
}

async function withServer(
  body: (ctx: {
    db: PGlite;
    options: ControlOptions & { store: VaultStore };
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
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const match = /^Bearer token-(.+)$/.exec(authorization);
      if (url.hostname === "supabase.test" && url.pathname === "/auth/v1/user" && match) {
        return Response.json({ id: match[1] });
      }
      return new Response("{}", { status: 401 });
    };
    const options = {
      supabaseUrl: "https://supabase.test",
      anonKey: "anon",
      store: createSqlVaultStore(db),
      encryptionKey: KEY,
      fetch: supabase,
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
                    accessToken: opts.token ?? `token-${userId}`,
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
