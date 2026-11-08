import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptSecret,
  EncryptionKeyError,
  encryptSecret,
  exchangeGitHubCode,
  GITHUB_NOT_CONNECTED,
  type GitHubApp,
  type GitHubConnectionStore,
  type GitHubResolveDeps,
  githubAppFromEnv,
  gitIdentity,
  gitSetupCommand,
  redact,
  resolveGitHubAccess,
  type StoredGitHubConnection,
} from "../src/index.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const USER = "22222222-2222-4222-8222-222222222222";
const APP: GitHubApp = { clientId: "Iv1.test", clientSecret: "client-secret-value" };
const REFRESH_1 = "ghr_refresh_one_aaaaaaaaaaaaaaaaaaaa";
const REFRESH_2 = "ghr_refresh_two_bbbbbbbbbbbbbbbbbbbb";
const REFRESH_3 = "ghr_refresh_three_cccccccccccccccccc";
const ACCESS_1 = "ghu_access_one_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCESS_2 = "ghu_access_two_bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("GitHub access at launch", () => {
  test("refreshes the user token, stores the rotated refresh token and returns the person's git identity", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push({
      access_token: ACCESS_1,
      refresh_token: REFRESH_2,
      expires_in: 28_800,
      refresh_token_expires_in: 15_811_200,
    });

    const access = await resolveGitHubAccess(world.deps, USER);

    expect(access).toEqual({
      status: "connected",
      token: ACCESS_1,
      identity: { login: "octocat", id: 583231, name: "The Octocat", email: "583231+octocat@users.noreply.github.com" },
    });
    expect(world.github.refreshTokensSent).toEqual([REFRESH_1]);
    expect(world.github.tokenRequests[0]).toMatchObject({ client_id: APP.clientId, grant_type: "refresh_token" });
    expect(world.github.userAuthorizations).toEqual([`Bearer ${ACCESS_1}`]);
    const row = world.rows.get(USER);
    expect(await decryptSecret(new Uint8Array(row?.refreshTokenEnc ?? []), KEY)).toBe(REFRESH_2);
    expect(row?.refreshExpiresAt?.toISOString()).toBe("2027-05-10T12:00:00.000Z");
    expect(JSON.stringify([...world.rows.values()])).not.toContain(ACCESS_1);
  });

  test("the profile on file follows the account GitHub reports", async () => {
    const world = await setup({ refresh: REFRESH_1, login: "old-name", githubId: 583231 });
    world.github.refreshes.push({ access_token: ACCESS_1, refresh_token: REFRESH_2, expires_in: 28_800 });

    await resolveGitHubAccess(world.deps, USER);

    expect(world.rows.get(USER)).toMatchObject({ login: "octocat", name: "The Octocat" });
  });

  test("no connection is a skip with a clear message, and GitHub is never called", async () => {
    const world = await setup({});
    expect(await resolveGitHubAccess(world.deps, USER)).toEqual({
      status: "not_connected",
      message: GITHUB_NOT_CONNECTED,
    });
    expect(world.github.tokenRequests).toEqual([]);
  });

  test("a connection already marked revoked is not refreshed", async () => {
    const world = await setup({ refresh: REFRESH_1, revoked: true });
    expect(await resolveGitHubAccess(world.deps, USER)).toMatchObject({ status: "revoked" });
    expect(world.github.tokenRequests).toEqual([]);
  });

  test("a refresh token GitHub refuses marks the connection revoked", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    });

    const access = await resolveGitHubAccess(world.deps, USER);

    expect(access).toMatchObject({ status: "revoked" });
    expect(world.rows.get(USER)?.revokedAt).toEqual(NOW);
    expect(await resolveGitHubAccess(world.deps, USER)).toMatchObject({ status: "revoked" });
    expect(world.github.tokenRequests).toHaveLength(1);
  });

  test("a launch that loses a refresh race retries with the token the winner stored", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push(async () => {
      // Another launch rotated the token while this one's request was in flight.
      await world.store.rotateGitHubToken(USER, world.rows.get(USER)?.refreshTokenEnc ?? new Uint8Array(), {
        refreshTokenEnc: await encryptSecret(REFRESH_2, KEY),
        refreshExpiresAt: null,
      });
      return { error: "bad_refresh_token" };
    });
    world.github.refreshes.push({ access_token: ACCESS_2, refresh_token: REFRESH_3, expires_in: 28_800 });

    const access = await resolveGitHubAccess(world.deps, USER);

    expect(access).toMatchObject({ status: "connected", token: ACCESS_2 });
    expect(world.github.refreshTokensSent).toEqual([REFRESH_1, REFRESH_2]);
    expect(world.rows.get(USER)?.revokedAt).toBeNull();
    expect(await decryptSecret(new Uint8Array(world.rows.get(USER)?.refreshTokenEnc ?? []), KEY)).toBe(REFRESH_3);
  });

  test("a GitHub outage skips GitHub without revoking or rotating anything", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push("down");
    const before = world.rows.get(USER)?.refreshTokenEnc;

    const access = await resolveGitHubAccess(world.deps, USER);

    expect(access).toMatchObject({ status: "unavailable" });
    expect(world.rows.get(USER)?.revokedAt).toBeNull();
    expect(world.rows.get(USER)?.refreshTokenEnc).toBe(before);
  });

  test("an App without expiring tokens, or without server credentials, is reported and not used", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push({ access_token: ACCESS_1 });
    const never = await resolveGitHubAccess(world.deps, USER);
    expect(never).toMatchObject({ status: "unavailable" });
    expect((never as { message: string }).message).toContain("Expire user authorization tokens");

    const missing = await resolveGitHubAccess({ ...world.deps, app: null }, USER);
    expect(missing).toMatchObject({ status: "unavailable" });
    expect((missing as { message: string }).message).toContain("GITHUB_APP_CLIENT_ID");
  });

  test("a token GitHub cannot tie to an account is not handed out", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    world.github.refreshes.push({ access_token: ACCESS_1, refresh_token: REFRESH_2, expires_in: 28_800 });
    world.github.userStatus = 401;

    expect(await resolveGitHubAccess(world.deps, USER)).toMatchObject({ status: "unavailable" });
    // The rotated refresh token is already stored: the connection survives.
    expect(await decryptSecret(new Uint8Array(world.rows.get(USER)?.refreshTokenEnc ?? []), KEY)).toBe(REFRESH_2);
  });

  test("a bad encryption key fails loudly instead of skipping", async () => {
    const world = await setup({ refresh: REFRESH_1 });
    await expect(resolveGitHubAccess({ ...world.deps, encryptionKey: undefined }, USER)).rejects.toBeInstanceOf(
      EncryptionKeyError,
    );
    expect(world.github.tokenRequests).toEqual([]);
  });

  test("the authorization code is traded with the redirect URL it was issued for", async () => {
    const world = await setup({});
    world.github.refreshes.push({ access_token: ACCESS_1, refresh_token: REFRESH_1, expires_in: 28_800 });
    const tokens = await exchangeGitHubCode(
      APP,
      { code: "code-1", redirectUri: "https://armada.thevibecompany.co/github/callback" },
      { fetch: world.github.fetch, now: () => NOW },
    );
    expect(world.github.tokenRequests[0]).toEqual({
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
      code: "code-1",
      redirect_uri: "https://armada.thevibecompany.co/github/callback",
    });
    expect(tokens.accessExpiresAt.toISOString()).toBe("2026-11-08T20:00:00.000Z");
    expect(tokens.refreshExpiresAt).toBeNull();
  });

  test("the App comes from two environment variables", () => {
    expect(githubAppFromEnv({ GITHUB_APP_CLIENT_ID: " id ", GITHUB_APP_CLIENT_SECRET: "secret" })).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
    expect(githubAppFromEnv({ GITHUB_APP_CLIENT_ID: "id" })).toBeNull();
  });

  test("GitHub tokens are masked in any output, known or not", () => {
    const text = `GH_TOKEN=${ACCESS_1} and ${REFRESH_1} and github_pat_11AAAAAAAAAAAAAAAAAAAA_bbbbbbbbbbbb`;
    expect(redact(text, [])).toBe("GH_TOKEN=*** and *** and ***");
  });
});

describe("git setup in the sandbox", () => {
  test("sets the identity and a credential helper that reads GH_TOKEN, and writes no token to disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "armada-git-"));
    try {
      const identity = gitIdentity({ id: 583231, login: "octocat", name: 'The "Octo\'cat"' });
      const env = { PATH: process.env.PATH ?? "", HOME: home, GH_TOKEN: ACCESS_1, GITHUB_TOKEN: ACCESS_1 };
      const setup = Bun.spawnSync(["sh", "-c", gitSetupCommand(identity)], { env });
      expect(setup.exitCode).toBe(0);

      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], { env, stdin: new Blob(["protocol=https\nhost=github.com\n\n"]) });
      expect(git("config", "--global", "user.name").stdout.toString().trim()).toBe(`The "Octo'cat"`);
      expect(git("config", "--global", "user.email").stdout.toString().trim()).toBe(
        "583231+octocat@users.noreply.github.com",
      );
      const filled = git("credential", "fill").stdout.toString();
      expect(filled).toContain("username=x-access-token");
      expect(filled).toContain(`password=${ACCESS_1}`);
      const rewritten = Bun.spawnSync(["git", "ls-remote", "--get-url", "git@github.com:acme/app.git"], { env });
      expect(rewritten.stdout.toString().trim()).toBe("https://github.com/acme/app.git");

      for (const name of readdirSync(home, { recursive: true, encoding: "utf8" })) {
        const path = join(home, name);
        try {
          expect(readFileSync(path, "utf8")).not.toContain(ACCESS_1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
        }
      }
      expect(gitSetupCommand(identity)).not.toContain(ACCESS_1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a name falls back to the login, and control characters never reach the shell", () => {
    expect(gitIdentity({ id: 1, login: "octocat", name: null }).name).toBe("octocat");
    expect(gitIdentity({ id: 1, login: "octocat", name: "A\nB\u0000C" }).name).toBe("A B C");
  });
});

type Reply = Record<string, unknown> | "down" | (() => Promise<Record<string, unknown>>);

async function setup(options: { refresh?: string; login?: string; githubId?: number; revoked?: boolean }) {
  const rows = new Map<string, StoredGitHubConnection>();
  if (options.refresh) {
    rows.set(USER, {
      userId: USER,
      githubId: options.githubId ?? 583231,
      login: options.login ?? "octocat",
      name: "The Octocat",
      refreshTokenEnc: await encryptSecret(options.refresh, KEY),
      refreshExpiresAt: null,
      revokedAt: options.revoked ? NOW : null,
    });
  }
  const store: GitHubConnectionStore = {
    async getGitHubConnection(userId) {
      return rows.get(userId) ?? null;
    },
    async rotateGitHubToken(userId, expected, next) {
      const row = rows.get(userId);
      if (!row || row.revokedAt || !equal(row.refreshTokenEnc, expected)) return false;
      rows.set(userId, { ...row, ...next });
      return true;
    },
    async markGitHubRevoked(userId, expected) {
      const row = rows.get(userId);
      if (!row || row.revokedAt || !equal(row.refreshTokenEnc, expected)) return false;
      rows.set(userId, { ...row, revokedAt: NOW });
      return true;
    },
    async updateGitHubProfile(userId, profile) {
      const row = rows.get(userId);
      if (row) rows.set(userId, { ...row, githubId: profile.id, login: profile.login, name: profile.name });
    },
  };

  const github = {
    refreshes: [] as Reply[],
    tokenRequests: [] as Record<string, string>[],
    refreshTokensSent: [] as string[],
    userAuthorizations: [] as string[],
    userStatus: 200,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        github.tokenRequests.push(body);
        if (body.refresh_token) {
          github.refreshTokensSent.push(body.refresh_token);
        }
        const reply = github.refreshes.shift();
        if (reply === undefined || reply === "down") throw new TypeError("connect ECONNREFUSED");
        return Response.json(typeof reply === "function" ? await reply() : reply);
      }
      if (url.href === "https://api.github.com/user") {
        github.userAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (github.userStatus !== 200)
          return Response.json({ message: "Bad credentials" }, { status: github.userStatus });
        return Response.json({ id: 583231, login: "octocat", name: "The Octocat" });
      }
      throw new Error(`unexpected request to ${url.href}`);
    }) as typeof fetch,
  };

  const deps: GitHubResolveDeps = { store, encryptionKey: KEY, app: APP, fetch: github.fetch, now: () => NOW };
  return { rows, store, github, deps };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
