import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EncryptionKeyError, type GitHubInstallation } from "@armada/core";
import {
  type ConnectDeps,
  completeGitHubConnection,
  decideGitHubCallback,
  githubAppIdentityFromEnv,
  githubAuthorizeUrl,
  githubCallbackUrl,
  githubInstallationManageUrl,
  githubInstallUrl,
  githubOAuthErrorLog,
  installationsForApp,
  isGitHubResult,
  newGitHubState,
  sameState,
  storedGitHubInstallations,
} from "../src/lib/github.ts";

const auditEvents: Record<string, unknown>[] = [];
let restoreInfo: (() => void) | undefined;
beforeEach(() => {
  auditEvents.length = 0;
  const log = spyOn(console, "info").mockImplementation((line) => {
    auditEvents.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
  restoreInfo = () => log.mockRestore();
});
afterEach(() => restoreInfo?.());

const APP = { clientId: "Iv1.test", clientSecret: "client-secret-value" };
const ACCESS = "ghu_0123456789abcdefghijABCDEFGHIJ0123";
const REFRESH = "ghr_0123456789abcdefghijABCDEFGHIJ0123";

const OURS: GitHubInstallation = {
  id: 42,
  appId: 7,
  appSlug: "armada-tvc",
  accountLogin: "octocat",
  accountType: "User",
  repositorySelection: "all",
};
const THEIRS: GitHubInstallation = {
  id: 99,
  appId: 8,
  appSlug: "other-app",
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
};

function github(options: { token?: Response; user?: Response; installations?: unknown } = {}) {
  const calls: { url: string; body: unknown; authorization: string | null }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url === "https://github.com/login/oauth/access_token") {
      return (
        options.token ??
        Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 28_800,
          refresh_token_expires_in: 15_811_200,
        })
      );
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return Response.json({ installations: options.installations ?? [] });
    }
    return options.user ?? Response.json({ id: 583231, login: "octocat", name: "Octo Cat" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(fetchImpl: typeof fetch, overrides: Partial<ConnectDeps> = {}) {
  const saved: Parameters<ConnectDeps["save"]>[0][] = [];
  const connect: ConnectDeps = {
    ownerId: "armada-owner",
    app: APP,
    encrypt: async (plaintext) => new TextEncoder().encode(`sealed:${plaintext}`),
    save: async (connection) => {
      saved.push(connection);
      return true;
    },
    fetch: fetchImpl,
    ...overrides,
  };
  return { connect, saved };
}

describe("completing Connect GitHub", () => {
  test("the code is traded for tokens, the person is looked up, and only the sealed refresh token is saved", async () => {
    const { calls, fetchImpl } = github();
    const { connect, saved } = deps(fetchImpl);
    const result = await completeGitHubConnection(connect, { code: "abc", redirectUri: "https://armada.test/cb" });
    expect(result).toBe("connected");
    expect(auditEvents).toEqual([
      {
        event: "github_connection_replaced",
        caller: "dashboard_callback",
        ownerId: "armada-owner",
        reason: "oauth_connect",
        githubId: 583231,
        accessTokenCached: false,
        accessExpiresAt: expect.any(String),
        observedRemainingLifetimeMs: expect.any(Number),
      },
    ]);
    expect(calls[0]?.body).toMatchObject({
      client_id: APP.clientId,
      code: "abc",
      redirect_uri: "https://armada.test/cb",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.user).toMatchObject({ id: 583231, login: "octocat" });
    expect(new TextDecoder().decode(saved[0]?.refreshTokenEnc)).toBe(`sealed:${REFRESH}`);
    expect(saved[0]?.installations).toBeNull();
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
  });

  test("no installation of this app redirects to install and saves nothing", async () => {
    const { calls, fetchImpl } = github({ installations: [apiInstallation(THEIRS)] });
    const logs: unknown[] = [];
    const { connect, saved } = deps(fetchImpl, { log: (fields) => logs.push(fields) });
    const result = await completeGitHubConnection(connect, {
      code: "abc",
      redirectUri: "https://armada.test/cb",
      appIdentity: { slug: "armada-tvc", appId: 7 },
    });
    expect(result).toBe("needs_install");
    expect(saved).toEqual([]);
    expect(logs).toEqual([]);
    expect(calls.some((call) => call.url.startsWith("https://api.github.com/user/installations"))).toBe(true);
    expect(calls.find((call) => call.url.includes("installations"))?.authorization).toBe(`Bearer ${ACCESS}`);
  });

  test("an installation of this app is saved, and one of another app is not", async () => {
    const { fetchImpl } = github({ installations: [apiInstallation(OURS), apiInstallation(THEIRS)] });
    const { connect, saved } = deps(fetchImpl);
    const result = await completeGitHubConnection(connect, {
      code: "abc",
      redirectUri: "https://armada.test/cb",
      appIdentity: { slug: "armada-tvc" },
    });
    expect(result).toBe("connected");
    expect(saved[0]?.installations).toEqual([
      { id: 42, account: "octocat", account_type: "User", repository_selection: "all" },
    ]);
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
    expect(JSON.stringify(saved)).not.toContain("acme");
  });

  test("an install return is saved only when that installation belongs to this app", async () => {
    const ours = github({ installations: [apiInstallation(OURS), apiInstallation(THEIRS)] });
    const savedOurs = deps(ours.fetchImpl);
    expect(
      await completeGitHubConnection(savedOurs.connect, {
        code: "abc",
        redirectUri: "u",
        appIdentity: { slug: "armada-tvc", appId: 7 },
        installationId: 42,
      }),
    ).toBe("connected");
    expect(savedOurs.saved[0]?.installations?.map((item) => item.id)).toEqual([42]);

    const other = github({ installations: [apiInstallation(THEIRS)] });
    const savedOther = deps(other.fetchImpl);
    expect(
      await completeGitHubConnection(savedOther.connect, {
        code: "abc",
        redirectUri: "u",
        appIdentity: { slug: "armada-tvc" },
        installationId: 99,
      }),
    ).toBe("not_installed");
    expect(savedOther.saved).toEqual([]);
  });

  test("a refused token logs only the OAuth error code and description", async () => {
    const leaked = `secret ${APP.clientSecret} token ${ACCESS}`;
    const { fetchImpl } = github({
      token: Response.json({
        error: "incorrect_client_credentials",
        error_description: leaked,
        access_token: ACCESS,
        refresh_token: REFRESH,
      }),
    });
    const logs: { error: string | null; error_description: string | null }[] = [];
    const { connect, saved } = deps(fetchImpl, { log: (fields) => logs.push(fields) });
    expect(await completeGitHubConnection(connect, { code: "x", redirectUri: "u" })).toBe("misconfigured");
    expect(logs).toEqual([{ error: "incorrect_client_credentials", error_description: "secret *** token ***" }]);
    expect(JSON.stringify(logs)).not.toContain(APP.clientSecret);
    expect(JSON.stringify(logs)).not.toContain(ACCESS);
    expect(JSON.stringify(logs)).not.toContain(REFRESH);
    expect(saved).toEqual([]);
  });

  test("a refused code, a misconfigured app and an outage each map to their own message", async () => {
    const refused = github({ token: Response.json({ error: "bad_verification_code" }) });
    expect(await completeGitHubConnection(deps(refused.fetchImpl).connect, { code: "x", redirectUri: "u" })).toBe(
      "bad_code",
    );

    const wrong = github({ token: Response.json({ error: "incorrect_client_credentials" }) });
    expect(await completeGitHubConnection(deps(wrong.fetchImpl).connect, { code: "x", redirectUri: "u" })).toBe(
      "misconfigured",
    );

    const down = github({ token: new Response("", { status: 503 }) });
    expect(await completeGitHubConnection(deps(down.fetchImpl).connect, { code: "x", redirectUri: "u" })).toBe(
      "unavailable",
    );
  });

  test("an app that does not expire user tokens is reported as misconfigured and nothing is saved", async () => {
    const { fetchImpl } = github({ token: Response.json({ access_token: ACCESS, token_type: "bearer" }) });
    const { connect, saved } = deps(fetchImpl);
    expect(await completeGitHubConnection(connect, { code: "x", redirectUri: "u" })).toBe("misconfigured");
    expect(saved).toEqual([]);
  });

  test("a missing encryption key and a refused write are reported, not thrown", async () => {
    const { fetchImpl } = github();
    const keyless = deps(fetchImpl, {
      encrypt: async () => {
        throw new EncryptionKeyError("ARMADA_ENCRYPTION_KEY is not set.");
      },
    });
    expect(await completeGitHubConnection(keyless.connect, { code: "x", redirectUri: "u" })).toBe("encryption");
    const refused = deps(fetchImpl, { save: async () => false });
    expect(await completeGitHubConnection(refused.connect, { code: "x", redirectUri: "u" })).toBe("not_saved");
  });

  test("every result code has a message, and unknown codes are not accepted", () => {
    expect(isGitHubResult("connected")).toBe(true);
    expect(isGitHubResult("not_saved")).toBe(true);
    expect(isGitHubResult("toString")).toBe(false);
    expect(isGitHubResult(undefined)).toBe(false);
  });
});

describe("GitHub URLs and state", () => {
  test("the authorize URL carries the client id, callback and state, never the secret", () => {
    const url = new URL(
      githubAuthorizeUrl(APP, { redirectUri: githubCallbackUrl("https://armada.test"), state: "s1" }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://armada.test/github/callback");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.toString()).not.toContain(APP.clientSecret);
  });

  test("the state is random and compared in full", () => {
    const state = newGitHubState();
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(newGitHubState()).not.toBe(state);
    expect(sameState(state, state)).toBe(true);
    expect(sameState(state, `${state.slice(0, -1)}${state.endsWith("0") ? "1" : "0"}`)).toBe(false);
    expect(sameState(state, null)).toBe(false);
    expect(sameState(undefined, state)).toBe(false);
    expect(sameState(state, state.slice(1))).toBe(false);
  });

  test("the install link needs a plausible app slug and keeps a state we issued", () => {
    const state = "ab".repeat(24);
    expect(githubInstallUrl("armada-by-vibe")).toBe("https://github.com/apps/armada-by-vibe/installations/new");
    expect(githubInstallUrl(" armada ", state)).toBe(`https://github.com/apps/armada/installations/new?state=${state}`);
    expect(githubInstallUrl("armada", "not-our-state")).toBe("https://github.com/apps/armada/installations/new");
    expect(githubInstallUrl(undefined)).toBeNull();
    expect(githubInstallUrl("../evil")).toBeNull();
  });

  test("a manage link stays on github.com", () => {
    expect(githubInstallationManageUrl({ id: 42, account: "octocat", accountType: "User" })).toBe(
      "https://github.com/settings/installations/42",
    );
    expect(githubInstallationManageUrl({ id: 7, account: "acme", accountType: "Organization" })).toBe(
      "https://github.com/organizations/acme/settings/installations/7",
    );
    expect(githubInstallationManageUrl({ id: 7, account: "acme/../../evil", accountType: "Organization" })).toBeNull();
    expect(githubInstallationManageUrl({ id: 0, account: "octocat", accountType: "User" })).toBeNull();
  });
});

describe("deciding what the callback does", () => {
  const state = "cd".repeat(24);
  const base = {
    error: null,
    stateCookie: state,
    stateParam: state,
    code: "good-code",
    setupAction: null,
    installationId: null,
    hasSession: true,
    canVerifyInstallation: true,
  };

  test("a plain OAuth return still requires the state cookie", () => {
    expect(decideGitHubCallback(base)).toEqual({ kind: "exchange", mode: "oauth", installationId: null });
    expect(decideGitHubCallback({ ...base, stateCookie: undefined })).toEqual({ kind: "result", result: "state" });
    expect(decideGitHubCallback({ ...base, stateParam: "forged" })).toEqual({ kind: "result", result: "state" });
    expect(
      decideGitHubCallback({ ...base, stateCookie: undefined, setupAction: "install", installationId: null }),
    ).toEqual({ kind: "result", result: "state" });
    expect(
      decideGitHubCallback({
        ...base,
        stateCookie: undefined,
        canVerifyInstallation: false,
        setupAction: "install",
        installationId: "42",
      }),
    ).toEqual({
      kind: "result",
      result: "state",
    });
  });

  test("an install return with a session continues without the state cookie", () => {
    const install = { ...base, stateCookie: undefined, stateParam: null, setupAction: "install", installationId: "42" };
    expect(decideGitHubCallback(install)).toEqual({ kind: "exchange", mode: "install", installationId: 42 });
    expect(
      decideGitHubCallback({ ...install, setupAction: "update", stateCookie: state, stateParam: "forged" }),
    ).toEqual({
      kind: "exchange",
      mode: "install",
      installationId: 42,
    });
  });

  test("an install return without an Armada session asks the person to sign in", () => {
    const decision = decideGitHubCallback({
      ...base,
      stateCookie: undefined,
      hasSession: false,
      setupAction: "install",
      installationId: "42",
    });
    expect(decision).toEqual({ kind: "result", result: "sign_in" });
    expect(isGitHubResult("sign_in") && decision.kind === "result" && decision.result === "sign_in").toBe(true);
  });

  test("GitHub's error query is access denied or a misconfigured app, and the log keeps only that", () => {
    expect(decideGitHubCallback({ ...base, error: "access_denied" })).toEqual({ kind: "result", result: "denied" });
    expect(decideGitHubCallback({ ...base, error: "redirect_uri_mismatch" })).toEqual({
      kind: "result",
      result: "misconfigured",
    });
    const params = new URLSearchParams({
      error: "redirect_uri_mismatch",
      error_description: `mismatch ${ACCESS}`,
      code: "super-secret-code",
      state: state,
    });
    expect(
      githubOAuthErrorLog({ error: params.get("error"), error_description: params.get("error_description") }),
    ).toEqual({ error: "redirect_uri_mismatch", error_description: "mismatch ***" });
    expect(githubOAuthErrorLog({ error: null, error_description: null })).toBeNull();
    expect(JSON.stringify(githubOAuthErrorLog({ error: "x", error_description: ACCESS }))).not.toContain(
      "super-secret",
    );
  });
});

describe("which installations belong to the app", () => {
  test("a slug and an app id both have to match when both are configured", () => {
    expect(githubAppIdentityFromEnv({ GITHUB_APP_SLUG: " armada-tvc ", GITHUB_APP_ID: "7" })).toEqual({
      slug: "armada-tvc",
      appId: 7,
    });
    expect(githubAppIdentityFromEnv({ GITHUB_APP_ID: "Iv1.nope" })).toEqual({});
    expect(installationsForApp([OURS, THEIRS], { slug: "Armada-TVC" })).toEqual([OURS]);
    expect(installationsForApp([OURS], { slug: "armada-tvc", appId: 8 })).toEqual([]);
    expect(installationsForApp([OURS, THEIRS], {})).toEqual([]);
  });

  test("a stored list drops anything that is not an installation", () => {
    expect(
      storedGitHubInstallations([
        { id: 7, account: "acme", account_type: "Organization", repository_selection: "selected" },
        { id: 7, account: "acme", account_type: "Organization", repository_selection: "selected" },
        { account: "../evil" },
        null,
      ]),
    ).toEqual([{ id: 7, account: "acme", account_type: "Organization", repository_selection: "selected" }]);
    expect(storedGitHubInstallations(null)).toEqual([]);
  });
});

function apiInstallation(installation: GitHubInstallation) {
  return {
    id: installation.id,
    app_id: installation.appId,
    app_slug: installation.appSlug,
    account: { login: installation.accountLogin, type: installation.accountType },
    repository_selection: installation.repositorySelection,
    target_type: installation.accountType,
  };
}
