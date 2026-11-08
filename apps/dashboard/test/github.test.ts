import { describe, expect, test } from "bun:test";
import { EncryptionKeyError } from "@armada/core";
import {
  type ConnectDeps,
  completeGitHubConnection,
  githubAuthorizeUrl,
  githubCallbackUrl,
  githubInstallUrl,
  isGitHubResult,
  newGitHubState,
  sameState,
} from "../src/lib/github.ts";

const APP = { clientId: "Iv1.test", clientSecret: "client-secret-value" };
const ACCESS = "ghu_0123456789abcdefghijABCDEFGHIJ0123";
const REFRESH = "ghr_0123456789abcdefghijABCDEFGHIJ0123";

function github(options: { token?: Response; user?: Response } = {}) {
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
    return options.user ?? Response.json({ id: 583231, login: "octocat", name: "Octo Cat" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(fetchImpl: typeof fetch, overrides: Partial<ConnectDeps> = {}) {
  const saved: Parameters<ConnectDeps["save"]>[0][] = [];
  const connect: ConnectDeps = {
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
    expect(calls[0]?.body).toMatchObject({
      client_id: APP.clientId,
      code: "abc",
      redirect_uri: "https://armada.test/cb",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.user).toMatchObject({ id: 583231, login: "octocat" });
    expect(new TextDecoder().decode(saved[0]?.refreshTokenEnc)).toBe(`sealed:${REFRESH}`);
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
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

  test("the install link needs a plausible app slug", () => {
    expect(githubInstallUrl("armada-by-vibe")).toBe("https://github.com/apps/armada-by-vibe/installations/new");
    expect(githubInstallUrl(" armada ")).toBe("https://github.com/apps/armada/installations/new");
    expect(githubInstallUrl(undefined)).toBeNull();
    expect(githubInstallUrl("../evil")).toBeNull();
  });
});
