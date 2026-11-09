import { expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { decryptSecret, encryptSecret } from "../../core/src/crypto.ts";
import {
  createOAuthBroker,
  createRemoteAuthResolver,
  type OAuthStore,
  type PendingAuthorization,
  type StoredGrant,
} from "../src/index.ts";

function fixture(
  mode: "cimd" | "dcr" | "preregistered" | "oidc" = "cimd",
  refresh = true,
  options: {
    split?: boolean;
    metadataIssuer?: string;
    redirect?: "metadata" | "token" | "registration" | "revocation";
    redirectTarget?: string;
  } = {},
) {
  const endpoints = {
    authorization: options.split ? "https://login.example/authorize" : "https://issuer.example/authorize",
    token: options.split ? "https://tokens.example/token?tenant=alpha" : "https://issuer.example/token",
    registration: options.split ? "https://clients.example/register" : "https://issuer.example/register",
    revocation: options.split ? "https://revoke.example/revoke" : "https://issuer.example/revoke",
  };
  let grant: StoredGrant | null = null;
  let revoked = false;
  let claimed = false;
  let version = 0;
  let generation = 1;
  let time = 1000;
  const pending = new Map<string, PendingAuthorization>();
  const requests: { url: string; body: URLSearchParams; headers: Headers }[] = [];
  const store: OAuthStore = {
    generation: async () => String(generation),
    readGrant: async () => grant,
    saveGrant: async (_id, expected, sealed, expectedGeneration) => {
      if (revoked || expectedGeneration !== String(generation) || (grant?.version ?? null) !== expected) return false;
      grant = { version: String(++version), sealed, generation: String(generation) };
      claimed = false;
      return true;
    },
    claimRefresh: async (_id, expected, expectedGeneration) => {
      if (claimed || revoked || expectedGeneration !== String(generation) || grant?.version !== expected) return false;
      claimed = true;
      return true;
    },
    revoke: async () => {
      generation++;
      revoked = true;
      grant = null;
    },
    putPending: async (state, record) => {
      pending.set(state, record);
    },
    takePending: async (state, actor, now) => {
      const record = pending.get(state);
      if (!record || record.actorId !== actor || record.expiresAt <= now) return null;
      pending.delete(state);
      return record;
    },
  };
  let beforeToken: (() => Promise<void>) | undefined;
  const fetcher: FetchLike = async (url, init) => {
    const request = new Request(String(url), init);
    const path = new URL(request.url).pathname;
    const body = new URLSearchParams(request.body ? await request.text() : "");
    requests.push({ url: request.url, body, headers: request.headers });
    expect(init?.redirect).toBe("error");
    if (!["/token", "/revoke"].includes(path)) expect(request.headers.has("authorization")).toBe(false);
    const purpose = path.includes("well-known/oauth-authorization-server")
      ? "metadata"
      : path === "/token"
        ? "token"
        : path === "/register"
          ? "registration"
          : path === "/revoke"
            ? "revocation"
            : undefined;
    if (purpose && options.redirect === purpose)
      return new Response(null, {
        status: 307,
        headers: { location: options.redirectTarget ?? "https://tokens.example/stolen" },
      });
    if (path === "/mcp")
      return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer scope="read"' } });
    if (path.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://service.example/mcp",
        authorization_servers: ["https://issuer.example"],
        scopes_supported: ["read"],
      });
    if (mode === "oidc" && path.includes("oauth-authorization-server")) return new Response(null, { status: 404 });
    if (path.includes("well-known"))
      return Response.json({
        issuer: options.metadataIssuer ?? "https://issuer.example",
        authorization_endpoint: endpoints.authorization,
        token_endpoint: endpoints.token,
        revocation_endpoint: endpoints.revocation,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: mode === "preregistered" ? ["client_secret_basic"] : ["none"],
        revocation_endpoint_auth_methods_supported: mode === "preregistered" ? ["client_secret_basic"] : ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: mode === "cimd" || mode === "oidc",
        ...(mode === "oidc"
          ? {
              jwks_uri: "https://issuer.example/jwks",
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
            }
          : {}),
        ...(mode === "dcr" ? { registration_endpoint: endpoints.registration } : {}),
      });
    if (path === "/register") {
      expect(request.url).toBe(endpoints.registration);
      return Response.json({
        client_id: "registered-fixture",
        redirect_uris: ["https://armada.example/callback"],
        token_endpoint: "https://untrusted.example/token",
      });
    }
    if (mode === "preregistered" && ["/token", "/revoke"].includes(path)) {
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("pre-fixture:secret-fixture")}`);
      expect(body.has("client_secret")).toBe(false);
    }
    if (path === "/token") {
      expect(request.url).toBe(endpoints.token);
      expect(body.get("resource")).toBe("https://service.example/mcp");
      if (body.get("grant_type") === "authorization_code")
        expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
      await beforeToken?.();
      return Response.json({
        token_endpoint: "https://untrusted.example/token",
        access_token: "access-fixture",
        ...(refresh ? { refresh_token: "rotation-fixture" } : {}),
        token_type: "Bearer",
        expires_in: 120,
        scope: "read",
      });
    }
    if (path === "/revoke") {
      expect(request.url).toBe(endpoints.revocation);
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected fixture request");
  };
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const broker = createOAuthBroker({
    store,
    vault: {
      seal: async (text) => Buffer.from(await encryptSecret(text, key)).toString("base64"),
      open: (text) => decryptSecret(new Uint8Array(Buffer.from(text, "base64")), key),
    },
    redirectUri: "https://armada.example/callback",
    clientMetadataUrl: "https://armada.example/client.json",
    now: () => time,
    fetch: fetcher,
    authorize: async (actor) => {
      if (actor !== "owner" || revoked) throw Error("denied");
    },
  });
  const connect = (clientIssuer = "https://issuer.example") =>
    broker.connect({
      actorId: "owner",
      connectionId: "connection",
      resource: "https://service.example/mcp",
      ...(mode === "preregistered"
        ? { client: { client_id: "pre-fixture", client_secret: "secret-fixture", issuer: clientIssuer } }
        : {}),
    });
  return {
    broker,
    endpoints,
    reopen: () => {
      revoked = false;
      generation++;
    },
    resolve: createRemoteAuthResolver({ fetch: fetcher }),
    connect,
    requests,
    expire: () => {
      time += 120_000;
    },
    beforeToken: (fn: () => Promise<void>) => {
      beforeToken = fn;
    },
  };
}

for (const mode of ["cimd", "dcr", "preregistered", "oidc"] as const) {
  test(`cross-origin OAuth ${mode}: PKCE exchange, actor/state/issuer binding, refresh and revocation`, async () => {
    const f = fixture(mode, true, { split: true });
    const { authorizationUrl } = await f.connect();
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(f.endpoints.authorization);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://service.example/mcp");
    const state = url.searchParams.get("state") ?? "";
    await expect(
      f.broker.callback({ actorId: "intruder", state, code: "fixture-code", issuer: "https://issuer.example" }),
    ).rejects.toThrow();
    await f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" });
    await expect(
      f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" }),
    ).rejects.toThrow();
    expect(await f.broker.access("owner", "connection", "https://service.example/mcp")).toBe("access-fixture");
    f.expire();
    expect(await f.broker.access("owner", "connection", "https://service.example/mcp")).toBe("access-fixture");
    expect(f.requests.filter((r) => r.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(await f.broker.revoke("owner", "connection")).toEqual({ upstreamRevocation: "done" });
    await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toThrow();
  });
}
test("refresh race admits one exchange; concurrent revoke defeats refresh CAS", async () => {
  const f = fixture();
  const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
  await f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" });
  f.expire();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeToken(async () => {
    entered();
    await held;
  });
  const refresh = f.broker.access("owner", "connection", "https://service.example/mcp");
  await started;
  await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toMatchObject({
    code: "busy",
  });
  await f.broker.revoke("owner", "connection");
  release();
  await expect(refresh).rejects.toMatchObject({ code: "needs_reconnect" });
  expect(f.requests.filter((r) => r.body.get("grant_type") === "refresh_token")).toHaveLength(1);
});
test("issuer mismatch is rejected before the code reaches a token endpoint", async () => {
  const f = fixture();
  const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
  await expect(
    f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://evil.example" }),
  ).rejects.toMatchObject({ code: "denied" });
  expect(f.requests.filter((r) => new URL(r.url).pathname === "/token")).toHaveLength(0);
});

test("provider without refresh tokens returns actionable reconnect instead of replaying a grant", async () => {
  const f = fixture("cimd", false);
  const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
  await f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" });
  f.expire();
  await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toMatchObject({
    code: "needs_reconnect",
  });
  expect(f.requests.filter((request) => request.body.get("grant_type") === "refresh_token")).toHaveLength(0);
});

test("automatic OAuth discovery reports authorization required without registering a client or creating a grant", async () => {
  const f = fixture("dcr");
  expect(await f.resolve({ url: "https://service.example/mcp", transport: "http" })).toEqual({
    authType: "oauth",
    state: "authorization_required",
    issuer: "https://issuer.example",
    resource: "https://service.example/mcp",
    scope: "read",
  });
  expect(f.requests.some((request) => ["/token", "/register"].includes(new URL(request.url).pathname))).toBe(false);
});

test("revocation and a fresh connect generation fence a callback already exchanging its code", async () => {
  const f = fixture();
  const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
  let entered!: () => void;
  const enteredToken = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeToken(async () => {
    entered();
    await held;
  });
  const callback = f.broker.callback({
    actorId: "owner",
    state,
    code: "fixture-code",
    issuer: "https://issuer.example",
  });
  await enteredToken;
  await f.broker.revoke("owner", "connection");
  f.reopen();
  release();
  await expect(callback).rejects.toMatchObject({ code: "needs_reconnect" });
  await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toMatchObject({
    code: "needs_reconnect",
  });
});

// These are protocol HTTP responses at the real broker boundary, not endpoint
// helper tests: neither the SDK nor the broker may follow or reuse credentials.
for (const redirect of ["metadata", "registration", "token", "revocation"] as const) {
  test(`${redirect} redirect cannot move an OAuth operation to another purpose or endpoint`, async () => {
    const f = fixture(redirect === "registration" ? "dcr" : "preregistered", true, {
      split: true,
      redirect,
      redirectTarget: redirect === "token" ? "https://revoke.example/revoke" : "https://tokens.example/stolen",
    });
    if (redirect === "metadata" || redirect === "registration") {
      await expect(f.connect()).rejects.toMatchObject({ code: "unsafe_endpoint" });
      expect(f.requests.some((request) => request.body.has("code") || request.body.has("refresh_token"))).toBe(false);
    } else {
      const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
      const callback = () =>
        f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" });
      if (redirect === "token") {
        await expect(callback()).rejects.toMatchObject({ code: "unsafe_endpoint" });
        await expect(callback()).rejects.toMatchObject({ code: "denied" });
        expect(f.requests.filter((request) => request.url === f.endpoints.token)).toHaveLength(1);
        expect(f.requests.some((request) => request.url === f.endpoints.revocation)).toBe(false);
      } else {
        await callback();
        expect(await f.broker.revoke("owner", "connection")).toEqual({ upstreamRevocation: "failed" });
        await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toThrow();
      }
    }
    expect(f.requests.some((request) => request.url.includes("/stolen"))).toBe(false);
    expect(
      f.requests
        .filter((request) => request.url.includes("well-known"))
        .every((request) => !request.headers.has("authorization") && !request.body.toString()),
    ).toBe(true);
  });
}

test("refresh redirect is an uncertain consumed exchange, never a replay at the redirected endpoint", async () => {
  const options: { split: boolean; redirect?: "token" } = { split: true };
  const f = fixture("preregistered", true, options);
  const state = new URL((await f.connect()).authorizationUrl).searchParams.get("state") ?? "";
  await f.broker.callback({ actorId: "owner", state, code: "fixture-code", issuer: "https://issuer.example" });
  options.redirect = "token";
  f.expire();
  await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toMatchObject({
    code: "needs_reconnect",
  });
  await expect(f.broker.access("owner", "connection", "https://service.example/mcp")).rejects.toMatchObject({
    code: "busy",
  });
  expect(f.requests.filter((request) => request.body.get("grant_type") === "refresh_token")).toHaveLength(1);
  expect(f.requests.some((request) => request.url.includes("/stolen"))).toBe(false);
});

for (const confusion of ["metadata-issuer", "preregistered-issuer"] as const) {
  test(`${confusion} confusion is rejected before any client secret or authorization code leaves`, async () => {
    const f = fixture("preregistered", true, {
      split: true,
      ...(confusion === "metadata-issuer" ? { metadataIssuer: "https://other-issuer.example" } : {}),
    });
    await expect(
      f.connect(confusion === "preregistered-issuer" ? "https://other-issuer.example" : "https://issuer.example"),
    ).rejects.toMatchObject({ code: "unsafe_endpoint" });
    expect(
      f.requests.some(
        (request) =>
          request.headers.has("authorization") || request.body.has("client_secret") || request.body.has("code"),
      ),
    ).toBe(false);
  });
}
