import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { fileSessionStore, memorySessionStore, type Session } from "../src/session.ts";

import { deviceCode, deviceLoginUrl, loginAuthorized, loginStarted } from "./device-login.fixture.ts";

const ORIGIN = "https://armada.example";
const ACCESS = "access-token";
const REFRESH = "refresh-token";

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: "2099-01-01T00:00:00.000Z",
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
        return Response.json({
          tokens: [
            { id: "token-id", label: "ci", orgName: "Example", createdAt: "2026-11-08T00:00:00Z", revokedAt: null },
          ],
        });
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

  test("token create forwards --org to Armada", async () => {
    const auth = io();
    auth.env = { ARMADA_URL: ORIGIN };
    await auth.session.write(session());
    auth.fetch = async (input, init) => {
      expect(String(input)).toBe(`${ORIGIN}/api/v1/token/create`);
      expect(await new Request(String(input), init).json()).toEqual({ orgName: "Example", label: "ci" });
      return Response.json({ id: "token-id", label: "ci", orgName: "Example", token: "armada_sk_fixture_secret" });
    };
    expect((await capture(["token", "create", "--org", "Example", "--label", "ci"], auth)).code).toBe(0);
  });

  test("ambiguous organization names are rejected by the Armada server", async () => {
    const auth = io();
    auth.env = { ARMADA_URL: ORIGIN };
    await auth.session.write(session());
    auth.fetch = async (input, init) => {
      expect(String(input)).toBe(`${ORIGIN}/api/v1/token/create`);
      expect(await new Request(String(input), init).json()).toEqual({ orgName: "Example" });
      return Response.json({ error: "ambiguous organization" }, { status: 409 });
    };
    const result = await capture(["token", "create", "--org", "Example"], auth);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Armada server request failed (409).");
    expect(result.out).not.toContain("armada_sk_");
  });

  test("token commands without a session ask for login", async () => {
    const result = await capture(["token", "list"], io());
    expect(result.code).toBe(3);
    expect(result.err).toContain("You are not signed in. Run armada login.");
  });

  test("logout clears the session", async () => {
    const auth = io();
    await auth.session.write(session());
    expect((await capture(["logout"], auth)).code).toBe(0);
    expect(await auth.session.read()).toBeNull();
  });

  test("login prints and opens one browser link, backs off, and saves the approved session", async () => {
    const auth = io();
    const calls: string[] = [];
    const waits: number[] = [];
    const opened: string[] = [];
    auth.sleep = async (ms) => {
      waits.push(ms);
    };
    auth.open = (url) => {
      opened.push(url);
      throw new Error("No local browser");
    };
    auth.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === `${ORIGIN}/api/v1/auth/device/start`) {
        expect(JSON.parse(String(init?.body)).hostname).toBeTruthy();
        return loginStarted();
      }
      expect(url).toBe(`${ORIGIN}/api/v1/auth/device/poll`);
      expect(JSON.parse(String(init?.body))).toEqual({ device_code: deviceCode });
      if (calls.length === 2) return Response.json({ status: "slow_down", interval: 10 });
      return loginAuthorized(undefined, undefined, "user!cli@example.test");
    };

    const result = await capture(["login", "--url", "armada.example"], auth);
    expect(result).toEqual({
      code: 0,
      out: "Signed in as user!cli@example.test.\n",
      err: `Open ${deviceLoginUrl} and confirm code 12AB34CD.\n`,
    });
    expect(waits).toEqual([5_000, 10_000]);
    expect(opened).toEqual([deviceLoginUrl]);
    expect(await auth.session.read()).toMatchObject({
      armadaUrl: ORIGIN,
      accessToken: "new-access",
      refreshToken: REFRESH,
    });
  });

  for (const args of [
    ["--provider", "github"],
    ["--email", "user@example.test"],
  ]) {
    test(`login rejects the removed ${args[0]} flag`, async () => {
      const auth = io();
      auth.fetch = async () => {
        throw new Error("Unexpected request");
      };
      expect((await capture(["login", ...args], auth)).code).toBe(2);
    });
  }

  test("saved API sessions refresh at the Armada origin and remain 0600 on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "armada-login-"));
    try {
      const path = join(directory, "session.json");
      const auth = io();
      auth.env = { ARMADA_URL: ORIGIN };
      auth.session = fileSessionStore(path);
      auth.interactive = false;
      const opened: string[] = [];
      auth.open = (url) => {
        opened.push(url);
      };
      const handoff = `${JSON.stringify({
        verificationUrl: deviceLoginUrl,
        userCode: "12AB34CD",
        expiresAt: "2026-11-08T00:10:00.000Z",
      })}\n`;
      let stdout = "";
      auth.out = (text) => {
        stdout += text;
      };
      auth.sleep = async () => {
        expect(stdout).toBe(handoff);
      };
      const calls: string[] = [];
      auth.fetch = async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === `${ORIGIN}/api/v1/auth/device/start`) return loginStarted();
        if (url === `${ORIGIN}/api/v1/auth/device/poll`) return loginAuthorized("first", "2026-11-08T00:00:30.000Z");
        if (url === `${ORIGIN}/api/v1/auth/refresh`) {
          expect(await new Request(url, init).json()).toEqual({ refreshToken: REFRESH });
          return Response.json({
            accessToken: "renewed",
            refreshToken: "rotated",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }
        if (url === `${ORIGIN}/api/v1/org/list`) {
          expect(authHeader(init)).toBe("Bearer renewed");
          return Response.json({ orgs: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      expect(await run(["login", "--json"], auth, { auth })).toBe(0);
      expect(stdout).toBe(`${handoff}{"authenticated":true}\n`);
      expect(opened).toEqual([]);
      const { control } = await import("../src/control.ts");
      expect(await control<{ orgs: unknown[] }>(auth, "org/list", {})).toEqual({ orgs: [] });
      expect(calls).toEqual([
        `${ORIGIN}/api/v1/auth/device/start`,
        `${ORIGIN}/api/v1/auth/device/poll`,
        `${ORIGIN}/api/v1/auth/refresh`,
        `${ORIGIN}/api/v1/org/list`,
      ]);
      expect((await auth.session.read())?.refreshToken).toBe("rotated");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
