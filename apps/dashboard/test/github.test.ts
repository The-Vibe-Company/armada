import { describe, expect, test } from "bun:test";
import { EncryptionKeyError } from "@armada/core";
import { NextResponse } from "next/server";
import {
  type ConnectDeps,
  completeGitHubConnection,
  githubAuthorizeUrl,
  githubCallbackUrl,
  githubInstallUrl,
  isGitHubResult,
  logGitHubCallback,
  newGitHubState,
  sameState,
  withGitHubStateCookie,
} from "../src/lib/github.ts";

const APP = { clientId: "Iv1.test", clientSecret: "client-secret-value" };
const ACCESS = "ghu_0123456789abcdefghijABCDEFGHIJ0123";
const REFRESH = "ghr_0123456789abcdefghijABCDEFGHIJ0123";

function github(
  options: { token?: Response; user?: Response; installations?: Record<string, unknown>[] | Response } = {},
) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
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
      if (options.installations instanceof Response) return options.installations;
      return Response.json({ installations: options.installations ?? [] });
    }
    return options.user ?? Response.json({ id: 583231, login: "octocat", name: "Octo Cat" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(fetchImpl: typeof fetch, overrides: Partial<ConnectDeps> = {}) {
  const saved: Parameters<ConnectDeps["save"]>[0][] = [];
  const connect: ConnectDeps = {
    app: APP,
    allowAccountChange: true,
    getExistingGithubId: async () => null,
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
    const outcome = await completeGitHubConnection(connect, { code: "abc", redirectUri: "https://armada.test/cb" });
    expect(outcome).toEqual({ result: "connected", needsInstall: false });
    expect(calls[0]?.body).toMatchObject({
      client_id: APP.clientId,
      code: "abc",
      redirect_uri: "https://armada.test/cb",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.user).toMatchObject({ id: 583231, login: "octocat" });
    expect(saved[0]?.installationId).toBeNull();
    expect(new TextDecoder().decode(saved[0]?.refreshTokenEnc)).toBe(`sealed:${REFRESH}`);
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
  });

  test("a refused code, a misconfigured app and an outage each map to their own message", async () => {
    const refused = github({ token: Response.json({ error: "bad_verification_code" }) });
    expect(
      (await completeGitHubConnection(deps(refused.fetchImpl).connect, { code: "x", redirectUri: "u" })).result,
    ).toBe("bad_code");

    const wrong = github({ token: Response.json({ error: "incorrect_client_credentials" }) });
    expect(
      (await completeGitHubConnection(deps(wrong.fetchImpl).connect, { code: "x", redirectUri: "u" })).result,
    ).toBe("misconfigured");

    const down = github({ token: new Response("", { status: 503 }) });
    expect((await completeGitHubConnection(deps(down.fetchImpl).connect, { code: "x", redirectUri: "u" })).result).toBe(
      "unavailable",
    );
  });

  test("an app that does not expire user tokens is reported as misconfigured and nothing is saved", async () => {
    const { fetchImpl } = github({ token: Response.json({ access_token: ACCESS, token_type: "bearer" }) });
    const { connect, saved } = deps(fetchImpl);
    expect((await completeGitHubConnection(connect, { code: "x", redirectUri: "u" })).result).toBe("misconfigured");
    expect(saved).toEqual([]);
  });

  test("a missing encryption key and a refused write are reported, not thrown", async () => {
    const { fetchImpl } = github();
    const keyless = deps(fetchImpl, {
      encrypt: async () => {
        throw new EncryptionKeyError("ARMADA_ENCRYPTION_KEY is not set.");
      },
    });
    expect((await completeGitHubConnection(keyless.connect, { code: "x", redirectUri: "u" })).result).toBe(
      "encryption",
    );
    const refused = deps(fetchImpl, { save: async () => false });
    expect((await completeGitHubConnection(refused.connect, { code: "x", redirectUri: "u" })).result).toBe("not_saved");
  });

  test("every result code has a message, and unknown codes are not accepted", () => {
    expect(isGitHubResult("connected")).toBe(true);
    expect(isGitHubResult("not_saved")).toBe(true);
    expect(isGitHubResult("install_pending")).toBe(true);
    expect(isGitHubResult("toString")).toBe(false);
    expect(isGitHubResult(undefined)).toBe(false);
  });
});

describe("auto-install: checking GET /user/installations", () => {
  test("without a slug configured, nothing is checked and the connection just succeeds", async () => {
    const { fetchImpl } = github();
    const { connect, saved } = deps(fetchImpl);
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "connected", needsInstall: false });
    expect(saved[0]?.installationId).toBeNull();
  });

  test("a slug configured but no matching installation says the person still needs to install it", async () => {
    const { fetchImpl } = github({ installations: [{ id: 1, app_slug: "some-other-app" }] });
    const { connect, saved } = deps(fetchImpl, { slug: "armada" });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "connected", needsInstall: true });
    expect(saved[0]?.installationId).toBeNull();
  });

  test("a matching installation is recorded and nothing more is asked of the person", async () => {
    const { fetchImpl } = github({
      installations: [
        { id: 1, app_slug: "some-other-app" },
        { id: 42, app_slug: "armada", account: { login: "acme", type: "Organization" } },
      ],
    });
    const { connect, saved } = deps(fetchImpl, { slug: "armada" });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "connected", needsInstall: false });
    expect(saved[0]?.installationId).toBe(42);
  });
});

describe("auto-install: an installation return never trusts the query string alone", () => {
  test("an installation_id GitHub's own list does not confirm is refused, not recorded", async () => {
    const { fetchImpl } = github({ installations: [{ id: 42, app_slug: "armada" }] });
    const { connect, saved } = deps(fetchImpl, { slug: "armada", claimedInstallationId: 99 });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "install_mismatch", needsInstall: false });
    expect(saved).toEqual([]);
  });

  test("a claimed installation_id without a configured slug cannot be corroborated, so it is refused", async () => {
    const { fetchImpl } = github({ installations: [{ id: 42, app_slug: "armada" }] });
    const { connect, saved } = deps(fetchImpl, { claimedInstallationId: 42 });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "install_mismatch", needsInstall: false });
    expect(saved).toEqual([]);
  });

  test("an installation_id GitHub confirms for this person and this app is trusted and recorded", async () => {
    const { fetchImpl } = github({ installations: [{ id: 42, app_slug: "armada" }] });
    const { connect, saved } = deps(fetchImpl, { slug: "armada", claimedInstallationId: 42 });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "connected", needsInstall: false });
    expect(saved[0]?.installationId).toBe(42);
  });
});

describe("auto-install: a round-trip without a matched CSRF state never switches accounts", () => {
  test("a different GitHub account already on file is refused, not silently swapped in", async () => {
    const { fetchImpl } = github();
    const { connect, saved } = deps(fetchImpl, {
      allowAccountChange: false,
      getExistingGithubId: async () => 999_999,
    });
    const outcome = await completeGitHubConnection(connect, { code: "x", redirectUri: "u" });
    expect(outcome).toEqual({ result: "mismatch", needsInstall: false });
    expect(saved).toEqual([]);
  });

  test("the same account on file, or no account on file yet, may still be saved", async () => {
    const { fetchImpl } = github();
    const sameAccount = deps(fetchImpl, { allowAccountChange: false, getExistingGithubId: async () => 583231 });
    expect((await completeGitHubConnection(sameAccount.connect, { code: "x", redirectUri: "u" })).result).toBe(
      "connected",
    );

    const firstTime = deps(fetchImpl, { allowAccountChange: false, getExistingGithubId: async () => null });
    expect((await completeGitHubConnection(firstTime.connect, { code: "x", redirectUri: "u" })).result).toBe(
      "connected",
    );
  });
});

describe("GitHub URLs, state and logging", () => {
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

  test("the install link needs a plausible app slug, and carries an optional state", () => {
    expect(githubInstallUrl("armada-by-vibe")).toBe("https://github.com/apps/armada-by-vibe/installations/new");
    expect(githubInstallUrl(" armada ")).toBe("https://github.com/apps/armada/installations/new");
    expect(githubInstallUrl(undefined)).toBeNull();
    expect(githubInstallUrl("../evil")).toBeNull();
    expect(githubInstallUrl("armada", "s1")).toBe("https://github.com/apps/armada/installations/new?state=s1");
  });

  test("the state cookie is http-only, scoped to the callback path and short-lived", () => {
    const response = withGitHubStateCookie(NextResponse.redirect("https://github.com/x"), "https://armada.test", "s1");
    const cookie = response.cookies.get("armada_github_state");
    expect(cookie).toMatchObject({ value: "s1", httpOnly: true, path: "/github/callback" });
    expect(response.cookies.get("armada_github_state")?.maxAge).toBe(600);
  });

  test("the callback log line never carries more than a known-safe result code", () => {
    const lines: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      logGitHubCallback({ result: "bad_code", installReturn: true });
    } finally {
      console.warn = original;
    }
    expect(lines).toEqual(["github callback: bad_code (install return)"]);
    expect(String(lines[0])).not.toContain(ACCESS);
    expect(String(lines[0])).not.toContain(REFRESH);
  });
});
