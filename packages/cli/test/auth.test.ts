import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAuthStore, fileSessionStore, memorySessionStore, type Session } from "@armada/auth";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

function session(): Session {
  return {
    userId: USER,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
    supabaseUrl: "http://127.0.0.1:54321",
  };
}

describe("auth commands", () => {
  test("token create prints the secret once and revoke removes it", async () => {
    const store = createMemoryAuthStore();
    store.addMembership(USER, { orgId: ORG, name: "Example", role: "admin" });
    const auth = io(store);
    await auth.session.write(session());
    const created = await capture(["token", "create", "--label", "ci"], auth);
    expect(created.code).toBe(0);
    expect(created.out).toContain("token: armada_sk_");
    const id = /id: (\S+)/.exec(created.out)?.[1] ?? "";
    const secret = /token: (\S+)/.exec(created.out)?.[1] ?? "";
    const listed = await capture(["token", "list"], auth);
    expect(listed.out).toContain(`${id}  ci  Example  active`);
    expect(listed.out).not.toContain(secret);
    const revoked = await capture(["token", "revoke", id], auth);
    expect(revoked.code).toBe(0);
    expect((await capture(["token", "list"], auth)).out).toContain("revoked");
  });

  test("token commands without a session ask for login", async () => {
    const auth = io(createMemoryAuthStore());
    const result = await capture(["token", "list"], auth);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Run armada login.");
  });

  test("logout clears the session", async () => {
    const auth = io(createMemoryAuthStore());
    await auth.session.write(session());
    expect((await capture(["logout"], auth)).code).toBe(0);
    expect(await auth.session.read()).toBeNull();
  });

  test("two orgs with the same name are refused", async () => {
    const store = createMemoryAuthStore();
    store.addMembership(USER, { orgId: ORG, name: "Example", role: "admin" });
    store.addMembership(USER, {
      orgId: "33333333-3333-4333-8333-333333333333",
      name: "Example",
      role: "member",
    });
    const auth = io(store);
    await auth.session.write(session());
    const result = await capture(["token", "create", "--org", "Example"], auth);
    expect(result.code).toBe(2);
    expect(result.err).toContain("More than one org has that name.");
    expect(result.out).not.toContain("armada_sk_");
  });

  test("an unknown provider is a usage error", async () => {
    const result = await capture(["login", "--provider", "password"], io(createMemoryAuthStore()));
    expect(result.code).toBe(2);
    expect(result.err).toContain("github or google");
  });

  test("login --email signs in with the code typed from the email", async () => {
    const auth = io(createMemoryAuthStore());
    const requests: string[] = [];
    auth.env = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon" };
    auth.readCode = async () => "123456";
    auth.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === "/auth/v1/verify") {
        return Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, user: { id: USER } });
      }
      return Response.json({});
    };
    const result = await capture(["login", "--email", "ada@example.com"], auth);
    expect(result.code).toBe(0);
    expect(result.err).toContain("Sent a sign-in email to ada@example.com");
    expect(result.out).toContain(`user: ${USER}`);
    expect(requests).toEqual(["/auth/v1/otp", "/auth/v1/verify"]);
    expect((await auth.session.read())?.userId).toBe(USER);
  });

  test.each(["flag", "environment", "default"])(
    "URL-only login (%s) survives a new process and refreshes before a control command",
    async (source) => {
      const directory = await mkdtemp(join(tmpdir(), "armada-login-"));
      try {
        const auth = io(createMemoryAuthStore());
        const path = join(directory, "session.json");
        auth.session = fileSessionStore(path);
        auth.readCode = async () => "123456";
        auth.readEmail = async () => "ada@example.com";
        if (source === "environment") auth.env = { ARMADA_URL: "https://armada.example" };
        const origin = source === "default" ? "https://armada.thevibecompany.co" : "https://armada.example";
        const requests: string[] = [];
        auth.fetch = async (input, init) => {
          const url = String(input);
          requests.push(url);
          if (url === `${origin}/.well-known/armada.json`) {
            expect(init?.headers).toBeUndefined();
            return Response.json({
              version: 1,
              supabaseUrl: "https://project.supabase.co",
              anonKey: "public",
              controlUrl: "https://mcp.example",
              providers: [],
            });
          }
          if (new URL(url).pathname === "/auth/v1/otp") return Response.json({});
          if (url.endsWith("/auth/v1/verify"))
            return Response.json({
              access_token: "first",
              refresh_token: "refresh",
              expires_in: 3600,
              user: { id: USER },
            });
          if (url.endsWith("/auth/v1/token?grant_type=refresh_token")) {
            expect(new Headers(init?.headers).get("apikey")).toBe("public");
            return Response.json({
              access_token: "renewed",
              refresh_token: "rotated",
              expires_in: 3600,
              user: { id: USER },
            });
          }
          if (url === "https://mcp.example/api/v1/org/list") {
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renewed");
            return Response.json({ orgs: [] });
          }
          throw new Error(`Unexpected request: ${url}`);
        };
        const result = await capture(
          source === "flag" ? ["login", "--url", "armada.example", "--email", "ada@example.com"] : ["login"],
          auth,
        );
        expect(result).toMatchObject({ code: 0, out: expect.stringContaining("Logged in.") });
        const reloaded = {
          ...auth,
          session: fileSessionStore(path),
          env: {},
          now: () => new Date("2026-11-08T02:00:00Z"),
        };
        const { control } = await import("../src/control.ts");
        expect(await control<{ orgs: unknown[] }>(reloaded, "org/list", {})).toEqual({ orgs: [] });
        expect(requests).toHaveLength(5);
        expect((await reloaded.session.read())?.refreshToken).toBe("rotated");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["http://armada.example", "HTTPS", false],
    ["https://user:password@armada.example", "HTTPS", false],
    ["https://armada.example", "Update the server", true],
  ])("refuses unsafe or unsupported discovery at %s", async (url, message, contacted) => {
    const auth = io(createMemoryAuthStore());
    let calls = 0;
    auth.fetch = async () => {
      calls++;
      return Response.json({ version: 2 });
    };
    const result = await capture(["login", "--url", url, "--email", "ada@example.com"], auth);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(message);
    expect(calls).toBe(contacted ? 1 : 0);
    expect(await auth.session.read()).toBeNull();
  });

  test("login takes --provider or --email, and a real address", async () => {
    const both = await capture(["login", "--provider", "github", "--email", "a@b.co"], io(createMemoryAuthStore()));
    expect(both.code).toBe(2);
    expect(both.err).toContain("not both");
    const bad = io(createMemoryAuthStore());
    bad.env = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon" };
    const invalid = await capture(["login", "--email", "nobody"], bad);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain("valid email");
  });
});

function io(store: ReturnType<typeof createMemoryAuthStore>): AuthIo {
  return {
    out: () => undefined,
    err: () => undefined,
    env: {},
    fetch: fetch,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    open: () => undefined,
    session: memorySessionStore(),
    store,
  };
}

async function capture(argv: string[], auth: AuthIo) {
  let out = "";
  let err = "";
  auth.out = (text) => {
    out += text;
  };
  auth.err = (text) => {
    err += text;
  };
  const code = await run(argv, { out: auth.out, err: auth.err }, { auth });
  return { code, out, err };
}

describe("authenticated request refresh", () => {
  test("retries one rejected read with a refreshed bearer", async () => {
    const { openSupabaseGoldens } = await import("../src/supabase.ts");
    const requests: string[] = [];
    let refreshes = 0;
    const opened = await openSupabaseGoldens(
      {
        supabaseUrl: "https://project.supabase.co",
        anonKey: "anon",
        accessToken: "old",
        userId: USER,
        refresh: async () => {
          refreshes++;
          return "new";
        },
      },
      undefined,
      async (_input, init) => {
        const token = new Headers(init?.headers).get("authorization") ?? "";
        requests.push(token);
        if (token === "Bearer old") return new Response("", { status: 401 });
        return Response.json([{ org_id: ORG, role: "admin", orgs: { name: "Example" } }]);
      },
    );
    expect(opened.actor.orgId).toBe(ORG);
    expect(refreshes).toBe(1);
    expect(requests).toEqual(["Bearer old", "Bearer new"]);
  });
});
