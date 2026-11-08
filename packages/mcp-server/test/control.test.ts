import { describe, expect, test } from "bun:test";
import { memorySessionStore } from "@armada/auth";
import { createSqlVaultStore, resolveBoatKey, resolveCredentials, type VaultStore } from "@armada/core";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import type { AuthIo } from "../../cli/src/auth-commands.ts";
import { run } from "../../cli/src/run.ts";
import { type ControlOptions, handleControlRequest } from "../src/index.ts";

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
