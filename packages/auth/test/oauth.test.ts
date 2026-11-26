import { describe, expect, test } from "bun:test";
import { seal } from "../src/cookie.ts";
import { createMemoryAuthStore } from "../src/memory.ts";
import { handleOAuthRequest, type OAuthServerOptions, oauthOptionsFromEnv } from "../src/oauth.ts";
import { createPkce, s256 } from "../src/pkce.ts";
import type { Provider } from "../src/supabase-auth.ts";
import type { AuthFetch } from "../src/types.ts";
import { authenticate } from "../src/verify.ts";
import { ORG_ID, proveAuth, USER_ID } from "./prove.ts";

const PUBLIC = "http://127.0.0.1:8080";

describe("oauth", () => {
  test("a client logs in with OAuth and a revoked service token is refused", async () => {
    const store = createMemoryAuthStore();
    store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
    const clock = { at: new Date("2026-11-08T00:00:00.000Z") };
    await proveAuth({
      store,
      now: () => clock.at,
      advance: (ms) => {
        clock.at = new Date(clock.at.getTime() + ms);
      },
      snapshot: async () => store.debugSnapshot(),
    });
  });

  test.each([
    { count: 1, action: "allow", status: 302 },
    { count: 2, action: "allow", status: 302 },
    { count: 1, action: "cancel", status: 302 },
    { count: 2, action: "cancel", status: 302 },
    { count: 1, action: "wrong-csrf", status: 400 },
    { count: 2, action: "wrong-org", status: 400 },
    { count: 1, action: "missing-decision", status: 400 },
    { count: 2, action: "stale-client", status: 400 },
    { count: 2, action: "stale-member", status: 400 },
    { count: 1, action: "cancel-stale-client", status: 400 },
    { count: 1, action: "cancel-wrong-csrf", status: 400 },
  ])("$count orgs: $action requires explicit validated consent", async ({ count, action, status }) => {
    const store = createMemoryAuthStore();
    const other = "00000000-0000-4000-8000-000000000011";
    store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
    if (count === 2) store.addMembership(USER_ID, { orgId: other, name: "Other", role: "member" });
    const redirectUri = "cursor://callback/complete";
    const pkce = await createPkce();
    let challenge = "";
    const server = {
      store,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { code_verifier?: string };
        if (!body.code_verifier || (await s256(body.code_verifier)) !== challenge)
          return new Response("no", { status: 400 });
        return Response.json({
          access_token: "supabase-access-token",
          refresh_token: "supabase-refresh-token",
          expires_in: 3600,
          user: { id: USER_ID },
        });
      }) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: "test-secret-at-least-16",
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    const registered = await handleOAuthRequest(
      new Request(`${PUBLIC}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: '<img src=x onerror="alert(1)">', redirect_uris: [redirectUri] }),
      }),
      server,
    );
    const client = (await registered?.json()) as { client_id: string };
    const authorize = await handleOAuthRequest(
      new Request(
        `${PUBLIC}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=original-state&resource=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
      ),
      server,
    );
    const cookie = authorize?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const login = await handleOAuthRequest(new Request(`${PUBLIC}/oauth/login`, { headers: { cookie } }), server);
    const href = /href="([^"]+)"/.exec((await login?.text()) ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    const start = await handleOAuthRequest(new Request(`${PUBLIC}${href}`, { headers: { cookie } }), server);
    challenge = new URL(start?.headers.get("location") ?? "").searchParams.get("code_challenge") ?? "";
    const callback = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/callback?code=ok`, { headers: { cookie } }),
      server,
    );
    expect(callback?.status).toBe(200);
    const html = await callback?.text();
    expect(html).toContain("Example");
    if (count === 2) expect(html).toContain("Other");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("cursor://callback");
    expect(html).not.toContain("destination: null");
    expect(html).toContain("does not verify");
    expect(html).toContain("running sandbox commands");
    expect(html).toContain(">Allow</button>");
    expect(html).toContain(">Cancel</button>");
    expect(callback?.headers.get("cache-control")).toBe("no-store");
    expect(callback?.headers.get("location")).toBeNull();
    expect(JSON.parse(store.debugSnapshot())).toMatchObject({ codes: [], tokens: [] });
    if (action.includes("stale-client")) store.findClient = async () => null;
    if (action === "stale-member") store.membership = async () => null;
    const nextCookie = callback?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(html ?? "")?.[1] ?? "";
    const chosen = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/org`, {
        method: "POST",
        headers: { cookie: nextCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf: action.includes("wrong-csrf") ? "incorrect" : csrf,
          org: action === "wrong-org" ? "not-a-membership" : count === 2 ? other : ORG_ID,
          ...(action === "missing-decision" ? {} : { decision: action.startsWith("cancel") ? "cancel" : "allow" }),
        }).toString(),
      }),
      server,
    );
    expect(chosen?.status).toBe(status);
    const stored = JSON.parse(store.debugSnapshot());
    if (action === "allow") {
      const location = new URL(chosen?.headers.get("location") ?? "");
      expect(location.protocol).toBe("cursor:");
      expect(location.searchParams.get("code")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("original-state");
      expect(stored.codes).toHaveLength(1);
      expect(stored.codes[0].orgId).toBe(count === 2 ? other : ORG_ID);
    } else {
      expect(stored).toMatchObject({ codes: [], tokens: [] });
      if (action === "cancel") {
        const location = new URL(chosen?.headers.get("location") ?? "");
        expect(location.protocol).toBe("cursor:");
        expect(location.host).toBe("callback");
        expect(location.searchParams.get("error")).toBe("access_denied");
        expect(location.searchParams.get("state")).toBe("original-state");
        expect(location.searchParams.has("code")).toBe(false);
      } else {
        expect(chosen?.headers.get("location")).toBeNull();
      }
    }
    if (action === "allow" || action === "cancel") {
      expect(chosen?.headers.getSetCookie().join(";")).toContain("Max-Age=0");
      expect(chosen?.headers.get("cache-control")).toBe("no-store");
    }
    expect(store.debugSnapshot()).not.toContain("supabase-access-token");
  });
  test("oversized OAuth JSON and form requests return OAuth 413 errors", async () => {
    const server = {
      store: createMemoryAuthStore(),
      fetch: (async () => {
        throw new Error("unexpected identity request");
      }) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: "test-secret-at-least-16",
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    for (const path of ["/register", "/token"]) {
      const response = await handleOAuthRequest(
        new Request(`${PUBLIC}${path}`, {
          method: "POST",
          body: "x".repeat(8193),
        }),
        server,
      );
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: "invalid_request" });
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a refused provider code exchange returns the HTML error page and clears the pending cookie", async () => {
    const store = createMemoryAuthStore();
    const pkce = await createPkce();
    const secret = "test-secret-at-least-16";
    const pending = await seal(
      {
        clientId: "client-id",
        redirectUri: "cursor://callback/complete",
        codeChallenge: pkce.challenge,
        resource: `${PUBLIC}/mcp`,
        csrf: "csrf",
        exp: Date.parse("2026-11-08T00:10:00.000Z"),
        supabaseVerifier: pkce.verifier,
      },
      secret,
    );
    const server = {
      store,
      fetch: (async () => new Response("invalid_grant", { status: 400 })) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: secret,
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    const response = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/callback?code=used`, { headers: { cookie: `armada_oauth=${pending}` } }),
      server,
    );

    expect(response?.status).toBe(400);
    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toContain("Start sign-in again");
    expect(response?.headers.getSetCookie().join(";")).toContain("Max-Age=0");
  });

  test("a callback with no provider verifier returns the HTML error page and clears the pending cookie", async () => {
    const store = createMemoryAuthStore();
    const secret = "test-secret-at-least-16";
    const pending = await seal(
      {
        clientId: "client-id",
        redirectUri: "cursor://callback/complete",
        codeChallenge: "challenge",
        resource: `${PUBLIC}/mcp`,
        csrf: "csrf",
        exp: Date.parse("2026-11-08T00:10:00.000Z"),
      },
      secret,
    );
    const server = {
      store,
      fetch: (async () => {
        throw new Error("unexpected identity request");
      }) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: secret,
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    const response = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/callback?code=unused`, { headers: { cookie: `armada_oauth=${pending}` } }),
      server,
    );

    expect(response?.status).toBe(400);
    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toContain("Start again from your client");
    expect(response?.headers.getSetCookie().join(";")).toContain("Max-Age=0");
  });

  test.each([
    { redirectUri: "https://client.example/oauth/callback", expectedTarget: "https://client.example" },
    { redirectUri: "http://127.0.0.1:9999/callback", expectedTarget: "http://127.0.0.1:9999" },
    { redirectUri: "http://[::1]:9999/callback", expectedTarget: "http://[::1]:9999" },
    { redirectUri: "claude://oauth/callback", expectedTarget: "claude:" },
    { redirectUri: "vscode://armada.ext/callback", expectedTarget: "vscode:" },
  ])(
    "orgPage CSP allows validated redirect_uri $redirectUri without navigate-to",
    async ({ redirectUri, expectedTarget }) => {
      const flow = await runAuthToConsent(redirectUri);
      expect(flow.login.headers.get("content-security-policy")).toBe("default-src 'none'; form-action 'self'");
      const csp = flow.callback.headers.get("content-security-policy") ?? "";
      expect(csp).toBe(`default-src 'none'; form-action 'self' ${expectedTarget}`);
      expect(csp).not.toContain("navigate-to");

      const chosen = await flow.allow();
      expect(chosen.status).toBe(302);
      expect(chosen.headers.get("location")?.startsWith(redirectUri)).toBe(true);
    },
  );

  test("register rejects non-loopback IPv6 HTTP redirect URIs", async () => {
    const rejected = await handleOAuthRequest(
      new Request(`${PUBLIC}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://[::2]:9999/callback"] }),
      }),
      makeTestServer(),
    );
    expect(rejected?.status).toBe(400);
  });

  test.each<{
    label: string;
    loginProviders?: readonly Provider[];
    status: number;
    expected: readonly Provider[];
    blocked: readonly Provider[];
  }>([
    { label: "default", status: 200, expected: ["github", "google"], blocked: [] },
    { label: "github only", loginProviders: ["github"], status: 200, expected: ["github"], blocked: ["google"] },
    { label: "google only", loginProviders: ["google"], status: 200, expected: ["google"], blocked: ["github"] },
    { label: "empty", loginProviders: [], status: 503, expected: [], blocked: ["github", "google"] },
  ])(
    "loginPage and /oauth/start respect configured loginProviders ($label)",
    async ({ loginProviders, status, expected, blocked }) => {
      const server = makeTestServer(loginProviders);
      const pending = await seal(
        {
          clientId: "client-id",
          redirectUri: "http://[::1]:9999/callback",
          codeChallenge: "challenge",
          resource: `${PUBLIC}/mcp`,
          csrf: "csrf-token",
          exp: Date.parse("2026-11-08T00:10:00.000Z"),
          supabaseVerifier: "verifier",
        },
        server.authSecret,
      );
      const headers = { cookie: `armada_oauth=${pending}` };
      const login = await handleOAuthRequest(new Request(`${PUBLIC}/oauth/login`, { headers }), server);
      expect(login?.status).toBe(status);
      const html = (await login?.text()) ?? "";
      for (const provider of expected) {
        expect(html).toContain(`/oauth/start?provider=${provider}&amp;csrf=csrf-token`);
        const start = await handleOAuthRequest(
          new Request(`${PUBLIC}/oauth/start?provider=${provider}&csrf=csrf-token`, { headers }),
          server,
        );
        expect(start?.status).toBe(302);
      }
      for (const provider of blocked) {
        expect(html).not.toContain(`provider=${provider}`);
        const start = await handleOAuthRequest(
          new Request(`${PUBLIC}/oauth/start?provider=${provider}&csrf=csrf-token`, { headers }),
          server,
        );
        expect(start?.status).toBe(400);
      }
    },
  );

  test("oauthOptionsFromEnv parses ARMADA_AUTH_PROVIDERS when set", () => {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-test",
      ARMADA_AUTH_SECRET: "test-secret-at-least-16",
      ARMADA_PUBLIC_URL: PUBLIC,
    };
    const store = createMemoryAuthStore();
    expect(oauthOptionsFromEnv({ store, env }).loginProviders).toBeUndefined();
    expect(oauthOptionsFromEnv({ store, env: { ...env, ARMADA_AUTH_PROVIDERS: "google" } }).loginProviders).toEqual([
      "google",
    ]);
    expect(oauthOptionsFromEnv({ store, env: { ...env, ARMADA_AUTH_PROVIDERS: "" } }).loginProviders).toEqual([]);
    expect(() => oauthOptionsFromEnv({ store, env: { ...env, ARMADA_AUTH_PROVIDERS: "unknown" } })).toThrow(
      "github or google",
    );
  });

  test("refresh_token succeeds when resource is omitted and rejects invalid resource", async () => {
    const redirectUri = "http://[::1]:9999/callback";
    const flow = await runAuthToConsent(redirectUri);
    const code = new URL((await flow.allow()).headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchanged = await postForm(flow.server, "/token", {
      grant_type: "authorization_code",
      code,
      client_id: flow.clientId,
      redirect_uri: redirectUri,
      code_verifier: flow.verifier,
      resource: `${PUBLIC}/mcp`,
    });
    const { refresh_token: refreshToken } = (await exchanged.json()) as { refresh_token: string };

    for (const badBody of [
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: flow.clientId,
        resource: "https://other.example/mcp",
      }),
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: flow.clientId,
        resource: "",
      }),
      new URLSearchParams([
        ["grant_type", "refresh_token"],
        ["refresh_token", refreshToken],
        ["client_id", flow.clientId],
        ["resource", `${PUBLIC}/mcp`],
        ["resource", "https://other.example/mcp"],
      ]),
    ]) {
      const bad = await postForm(flow.server, "/token", badBody);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_target" });
    }

    const refreshed = await postForm(flow.server, "/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: flow.clientId,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect((await authenticate(`Bearer ${rotated.access_token}`, flow.store, flow.now)).ok).toBe(true);
    expect(rotated.refresh_token).not.toBe(refreshToken);
  });
});

function makeTestServer(loginProviders?: readonly Provider[]) {
  return {
    store: createMemoryAuthStore(),
    fetch: async () => {
      throw new Error("unexpected identity request");
    },
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon-test",
    authSecret: "test-secret-at-least-16",
    publicUrl: PUBLIC,
    now: () => new Date("2026-11-08T00:00:00.000Z"),
    ...(loginProviders !== undefined ? { loginProviders } : {}),
  } satisfies OAuthServerOptions;
}

async function postForm(server: OAuthServerOptions, path: string, body: Record<string, string> | URLSearchParams) {
  const form = body instanceof URLSearchParams ? body : new URLSearchParams(body);
  const response = await handleOAuthRequest(
    new Request(`${PUBLIC}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    server,
  );
  if (!response) throw new Error(`missing response for ${path}`);
  return response;
}

async function runAuthToConsent(redirectUri: string) {
  const store = createMemoryAuthStore();
  store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
  const now = new Date("2026-11-08T00:00:00.000Z");
  const pkce = await createPkce();
  let challenge = "";
  const server: OAuthServerOptions = {
    ...makeTestServer(),
    store,
    now: () => now,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { code_verifier?: string };
      if (!body.code_verifier || (await s256(body.code_verifier)) !== challenge) {
        return new Response("no", { status: 400 });
      }
      return Response.json({
        access_token: "supabase-access-token",
        refresh_token: "supabase-refresh-token",
        expires_in: 3600,
        user: { id: USER_ID },
      });
    },
  };
  const registered = await handleOAuthRequest(
    new Request(`${PUBLIC}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "MCP Client", redirect_uris: [redirectUri] }),
    }),
    server,
  );
  if (!registered) throw new Error("missing register response");
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const authz = await handleOAuthRequest(
    new Request(
      `${PUBLIC}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=s1&resource=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
    ),
    server,
  );
  const cookie = authz?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const login = await handleOAuthRequest(new Request(`${PUBLIC}/oauth/login`, { headers: { cookie } }), server);
  if (!login) throw new Error("missing login response");
  const href = /href="([^"]+)"/.exec(await login.text())?.[1]?.replaceAll("&amp;", "&") ?? "";
  const start = await handleOAuthRequest(new Request(`${PUBLIC}${href}`, { headers: { cookie } }), server);
  challenge = new URL(start?.headers.get("location") ?? "").searchParams.get("code_challenge") ?? "";
  const callback = await handleOAuthRequest(
    new Request(`${PUBLIC}/oauth/callback?code=ok`, { headers: { cookie } }),
    server,
  );
  if (!callback) throw new Error("missing callback response");
  expect(callback.status).toBe(200);
  const nextCookie = callback.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(await callback.text())?.[1] ?? "";
  return {
    store,
    server,
    now,
    clientId,
    verifier: pkce.verifier,
    login,
    callback,
    allow: async () => {
      const response = await handleOAuthRequest(
        new Request(`${PUBLIC}/oauth/org`, {
          method: "POST",
          headers: { cookie: nextCookie, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf, org: ORG_ID, decision: "allow" }).toString(),
        }),
        server,
      );
      if (!response) throw new Error("missing org response");
      return response;
    },
  };
}
