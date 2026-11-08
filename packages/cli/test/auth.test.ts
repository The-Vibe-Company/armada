import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSessionStore, memorySessionStore, type Session } from "@armada/auth";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

const ORIGIN = "https://armada.example";
const ACCESS = "access-token";
const REFRESH = "refresh-token";

function session(overrides: Partial<Session> = {}): Session {
  return {
    userId: "",
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: "2099-01-01T00:00:00.000Z",
    supabaseUrl: "",
    armadaUrl: ORIGIN,
    ...overrides,
  };
}

function io(): AuthIo {
  return {
    out: () => undefined,
    err: () => undefined,
    env: {},
    fetch,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    open: () => undefined,
    session: memorySessionStore(),
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

function authHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

describe("auth commands", () => {
  test("token create, list, and revoke use Armada API and redact the created secret", async () => {
    const auth = io();
    auth.env = { ARMADA_URL: ORIGIN };
    await auth.session.write(session());
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const secret = "armada_sk_fixture_secret";
    auth.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      expect(authHeader(init)).toBe(`Bearer ${ACCESS}`);
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      if (url === `${ORIGIN}/api/v1/token/create`) {
        expect(init?.method).toBe("POST");
        expect(await new Request(url, init).json()).toEqual({ label: "ci" });
        return Response.json({ id: "token-id", label: "ci", orgName: "Example", token: secret });
      }
      if (url === `${ORIGIN}/api/v1/token/list`) {
        expect(init?.method).toBe("POST");
        return Response.json({ tokens: [{ id: "token-id", label: "ci", orgName: "Example", createdAt: "2026-11-08T00:00:00Z", revokedAt: null }] });
      }
      if (url === `${ORIGIN}/api/v1/token/revoke`) {
        expect(init?.method).toBe("POST");
        expect(await new Request(url, init).json()).toEqual({ id: "token-id" });
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const created = await capture(["token", "create", "--label", "ci"], auth);
    expect(created).toMatchObject({ code: 0, out: expect.stringContaining(`token: ${secret}`) });
    const listed = await capture(["token", "list"], auth);
    expect(listed).toMatchObject({ code: 0, out: expect.stringContaining("token-id  ci  Example  active") });
    expect(calls).toHaveLength(2);
    const revoked = await capture(["token", "revoke", "token-id"], auth);
    expect(revoked).toMatchObject({ code: 0, out: "Revoked token-id.\n" });
    expect(calls.map(({ url }) => url)).toEqual([
      `${ORIGIN}/api/v1/token/create`,
      `${ORIGIN}/api/v1/token/list`,
      `${ORIGIN}/api/v1/token/revoke`,
    ]);
  });

  test("token commands without a session ask for login", async () => {
    const result = await capture(["token", "list"], io());
    expect(result.code).toBe(1);
    expect(result.err).toContain("Set ARMADA_TOKEN or run armada login.");
  });

  test("ARMADA_TOKEN owns token requests without reading a saved session", async () => {
    const auth = io();
    auth.env = { ARMADA_URL: ORIGIN, ARMADA_TOKEN: "environment-token" };
    auth.session = {
      read: async () => {
        throw new Error("saved session must not be read");
      },
      write: async () => undefined,
      clear: async () => undefined,
    };
    auth.fetch = async (input, init) => {
      expect(String(input)).toBe(`${ORIGIN}/api/v1/token/list`);
      expect(authHeader(init)).toBe("Bearer environment-token");
      return Response.json({ tokens: [] });
    };
    expect(await capture(["token", "list"], auth)).toMatchObject({ code: 0, out: "No service tokens.\n" });
  });

  test("logout clears the session", async () => {
    const auth = io();
    await auth.session.write(session());
    expect((await capture(["logout"], auth)).code).toBe(0);
    expect(await auth.session.read()).toBeNull();
  });

  test("an unknown provider is a usage error", async () => {
    const result = await capture(["login", "--provider", "password"], io());
    expect(result.code).toBe(2);
    expect(result.err).toContain("github or google");
  });

  test("email login calls only Armada auth endpoints and persists its API session", async () => {
    const auth = io();
    auth.env = { ARMADA_URL: ORIGIN };
    auth.readCode = async () => "123456";
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    auth.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      expect(authHeader(init)).toBeNull();
      if (url === `${ORIGIN}/api/v1/auth/email/start`) {
        expect(init?.method).toBe("POST");
        const body = (await new Request(url, init).json()) as Record<string, string>;
        expect(body.email).toBe("ada@example.com");
        expect(body.redirect_uri).toBe("http://127.0.0.1:1/callback");
        expect(body.code_challenge).toBe("a".repeat(43));
        expect(body.state).toMatch(/^[a-f0-9]{32}$/);
        return Response.json({});
      }
      if (url === `${ORIGIN}/api/v1/auth/email/verify`) {
        expect(init?.method).toBe("POST");
        expect(await new Request(url, init).json()).toEqual({ email: "ada@example.com", code: "123456" });
        return Response.json({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await capture(["login", "--email", "ada@example.com"], auth);
    expect(result).toMatchObject({ code: 0, out: "Logged in.\n", err: expect.stringContaining("Type the code") });
    expect(calls.map(({ url }) => url)).toEqual([`${ORIGIN}/api/v1/auth/email/start`, `${ORIGIN}/api/v1/auth/email/verify`]);
    expect(await auth.session.read()).toEqual(session());
  });

  test("saved API sessions refresh at the Armada origin and remain 0600 on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "armada-login-"));
    try {
      const path = join(directory, "session.json");
      const auth = io();
      auth.env = { ARMADA_URL: ORIGIN };
      auth.session = fileSessionStore(path);
      auth.readCode = async () => "123456";
      const calls: string[] = [];
      auth.fetch = async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === `${ORIGIN}/api/v1/auth/email/start`) return Response.json({});
        if (url === `${ORIGIN}/api/v1/auth/email/verify`) return Response.json({ accessToken: "first", refreshToken: REFRESH, expiresAt: "2026-11-08T00:00:30.000Z" });
        if (url === `${ORIGIN}/api/v1/auth/refresh`) {
          expect(await new Request(url, init).json()).toEqual({ refreshToken: REFRESH });
          return Response.json({ accessToken: "renewed", refreshToken: "rotated", expiresAt: "2099-01-01T00:00:00.000Z" });
        }
        if (url === `${ORIGIN}/api/v1/org/list`) {
          expect(authHeader(init)).toBe("Bearer renewed");
          return Response.json({ orgs: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      expect((await capture(["login", "--email", "ada@example.com"], auth)).code).toBe(0);
      const { control } = await import("../src/control.ts");
      expect(await control<{ orgs: unknown[] }>(auth, "org/list", {})).toEqual({ orgs: [] });
      expect(calls).toEqual([
        `${ORIGIN}/api/v1/auth/email/start`,
        `${ORIGIN}/api/v1/auth/email/verify`,
        `${ORIGIN}/api/v1/auth/refresh`,
        `${ORIGIN}/api/v1/org/list`,
      ]);
      expect((await auth.session.read())?.refreshToken).toBe("rotated");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("email login sends requests only to the supplied Armada origin", async () => {
    const auth = io();
    auth.readCode = async () => "123456";
    const calls: string[] = [];
    auth.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/email/start")) return Response.json({});
      return Response.json({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2099-01-01T00:00:00.000Z" });
    };
    expect((await capture(["login", "--url", "https://armada.example", "--email", "ada@example.com"], auth)).code).toBe(0);
    expect(calls).toEqual([
      "https://armada.example/api/v1/auth/email/start",
      "https://armada.example/api/v1/auth/email/verify",
    ]);
  });

  test("login takes --provider or --email, and a real address", async () => {
    const both = await capture(["login", "--provider", "github", "--email", "a@b.co"], io());
    expect(both.code).toBe(2);
    expect(both.err).toContain("not both");
    const invalidAuth = io();
    invalidAuth.readCode = async () => "123456";
    const invalid = await capture(["login", "--email", "nobody"], invalidAuth);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("Armada could not start email login.");
  });
});
