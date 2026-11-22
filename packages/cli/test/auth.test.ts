import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

  test("plain login replaces an invalid saved session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "armada-invalid-session-"));
    try {
      const path = join(directory, "session.json");
      await writeFile(path, "invalid session", { mode: 0o600 });
      const auth = io();
      auth.session = fileSessionStore(path);
      auth.sleep = async () => {};
      auth.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/auth/device/start")) return loginStarted();
        if (path.endsWith("/auth/device/poll")) return loginAuthorized();
        throw new Error("Unexpected login request");
      };

      expect((await capture(["login"], auth)).code).toBe(0);
      expect((await auth.session.read())?.accessToken).toBe("new-access");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
