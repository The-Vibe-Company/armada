import { BodyTooLargeError, readBoundedText } from "./bounded-body.ts";
import { bearerKind, generateClientId, generateCode, generateToken, randomHex, sha256Hex } from "./codec.ts";
import { clearCookie, openSeal, type PendingLogin, readCookie, seal, writeCookie } from "./cookie.ts";
import { AuthError } from "./errors.ts";
import { loginPage, orgPage, page } from "./html.ts";
import { refreshClientId, refreshLabel } from "./labels.ts";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  assertPublicUrl,
  LOGIN_TTL_MS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_TTL_MS,
  resourceUrl,
} from "./limits.ts";
import { createPkce, pkceMatches, s256 } from "./pkce.ts";
import { isAllowedRedirect } from "./redirect.ts";
import { assertProvider, assertSupabaseUrl, exchangeSupabaseCode, supabaseAuthorizeUrl } from "./supabase-auth.ts";
import type { AuthFetch, AuthStore } from "./types.ts";
import { fresh } from "./verify.ts";

const PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/authorize",
  "/oauth/login",
  "/oauth/start",
  "/oauth/callback",
  "/oauth/org",
  "/token",
  "/revoke",
]);

const CORS_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/token",
  "/revoke",
]);

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * MCP OAuth 2.1 routes (metadata, dynamic registration, authorize, token, refresh, revoke).
 * Returns null when the path is not an auth route, so #464 can try this before the MCP endpoint.
 * Issued Armada tokens are stored as lowercase sha-256 hex on `mcp_tokens`.
 */
export interface OAuthServerOptions {
  store: AuthStore;
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  authSecret: string;
  /** Origin only, for example `https://armada.example.com`. */
  publicUrl: string;
  now: () => Date;
}

export function oauthOptionsFromEnv(options: {
  store: AuthStore;
  fetch?: AuthFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): OAuthServerOptions {
  const env = options.env ?? process.env;
  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const authSecret = env.ARMADA_AUTH_SECRET;
  const publicUrl = env.ARMADA_PUBLIC_URL;
  if (!supabaseUrl || !anonKey || !authSecret || !publicUrl) {
    throw new AuthError("Set SUPABASE_URL, SUPABASE_ANON_KEY, ARMADA_AUTH_SECRET and ARMADA_PUBLIC_URL.", "usage");
  }
  if (authSecret.length < 16) throw new AuthError("ARMADA_AUTH_SECRET must be at least 16 characters.", "usage");
  return {
    store: options.store,
    fetch: options.fetch ?? fetch,
    supabaseUrl: assertSupabaseUrl(supabaseUrl),
    anonKey,
    authSecret,
    publicUrl: assertPublicUrl(publicUrl),
    now: options.now ?? (() => new Date()),
  };
}

export async function handleOAuthRequest(request: Request, options: OAuthServerOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (!PATHS.has(url.pathname)) return null;
  if (request.method === "OPTIONS" && CORS_PATHS.has(url.pathname)) {
    return new Response(null, { status: 204, headers: cors() });
  }
  try {
    const response = await route(request, url, options);
    return CORS_PATHS.has(url.pathname) ? withCors(response) : response;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return oauthError(413, "invalid_request", "The request is too large.");
    if (error instanceof AuthError && error.code === "unavailable") {
      return oauthError(503, "server_error", "Armada could not complete the request.");
    }
    if (error instanceof AuthError) return oauthError(400, "invalid_request", error.message);
    return oauthError(500, "server_error", "Armada could not complete the request.");
  }
}

async function route(request: Request, url: URL, options: OAuthServerOptions): Promise<Response> {
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource":
    case "/.well-known/oauth-protected-resource/mcp":
      return metadata(options, "resource");
    case "/.well-known/oauth-authorization-server":
      return metadata(options, "server");
    case "/register":
      return request.method === "POST" ? register(request, options) : methodNotAllowed();
    case "/authorize":
      return request.method === "GET" ? authorize(url, options) : methodNotAllowed();
    case "/oauth/login":
      return request.method === "GET" ? showLogin(request, options) : methodNotAllowed();
    case "/oauth/start":
      return request.method === "GET" ? startProvider(url, request, options) : methodNotAllowed();
    case "/oauth/callback":
      return request.method === "GET" ? callback(url, request, options) : methodNotAllowed();
    case "/oauth/org":
      return request.method === "POST" ? chooseOrg(request, options) : methodNotAllowed();
    case "/token":
      return request.method === "POST" ? token(request, options) : methodNotAllowed();
    case "/revoke":
      return request.method === "POST" ? revoke(request, options) : methodNotAllowed();
    default:
      return oauthError(404, "invalid_request", "Unknown auth route.");
  }
}

function metadata(options: OAuthServerOptions, kind: "resource" | "server"): Response {
  const origin = assertPublicUrl(options.publicUrl);
  if (kind === "resource") {
    return json(
      {
        resource: resourceUrl(origin),
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        scopes_supported: [OAUTH_SCOPE],
      },
      200,
      "public, max-age=300",
    );
  }
  return json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [OAUTH_SCOPE],
    },
    200,
    "public, max-age=300",
  );
}

async function register(request: Request, options: OAuthServerOptions): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body)) return oauthError(400, "invalid_client_metadata", "Expected a JSON object.");
  const redirectUris = stringList(body.redirect_uris);
  if (!redirectUris || redirectUris.length < 1 || redirectUris.length > 8) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be 1 to 8 URLs.");
  }
  if (redirectUris.some((uri) => !isAllowedRedirect(uri)) || new Set(redirectUris).size !== redirectUris.length) {
    return oauthError(400, "invalid_redirect_uri", "A redirect URI must be loopback http, https, or a native scheme.");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Only public clients are registered.");
  }
  if (body.client_secret !== undefined)
    return oauthError(400, "invalid_client_metadata", "Only public clients are registered.");
  const grants =
    body.grant_types === undefined ? ["authorization_code", "refresh_token"] : stringList(body.grant_types);
  const responses = body.response_types === undefined ? ["code"] : stringList(body.response_types);
  if (!grants || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
    return oauthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token are supported.");
  }
  if (!responses || responses.some((item) => item !== "code")) {
    return oauthError(400, "invalid_client_metadata", "Only the code response type is supported.");
  }
  let name = "MCP client";
  if (body.client_name !== undefined) {
    if (typeof body.client_name !== "string")
      return oauthError(400, "invalid_client_metadata", "client_name must be a string.");
    name = body.client_name.trim();
    if (name.length < 1 || name.length > 80)
      return oauthError(400, "invalid_client_metadata", "client_name must be 1-80 characters.");
  }
  const id = generateClientId();
  await options.store.insertClient({ id, name, redirectUris });
  return json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

async function authorize(url: URL, options: OAuthServerOptions): Promise<Response> {
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const client = clientId ? await options.store.findClient(clientId) : null;
  const registered = client?.redirectUris.includes(redirectUri) === true && isAllowedRedirect(redirectUri);
  if (!client || !registered)
    return page("Authorization failed", "<p>The client or redirect URI is not registered.</p>", 400);
  const state = url.searchParams.get("state") ?? undefined;
  if (state !== undefined && state.length > 512)
    return failRedirect(redirectUri, "invalid_request", "state is too long.", state);
  if (url.searchParams.get("response_type") !== "code") {
    return failRedirect(redirectUri, "unsupported_response_type", "response_type must be code.", state);
  }
  const challenge = url.searchParams.get("code_challenge") ?? "";
  if (url.searchParams.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) {
    return failRedirect(redirectUri, "invalid_request", "PKCE S256 is required.", state);
  }
  const resource = url.searchParams.get("resource");
  if (!resource || !sameResource(resource, resourceUrl(options.publicUrl))) {
    return failRedirect(redirectUri, "invalid_target", "resource must be this server's MCP endpoint.", state);
  }
  const scope = url.searchParams.get("scope");
  if (scope !== null && scope.length > 200)
    return failRedirect(redirectUri, "invalid_scope", "scope is too long.", state);
  const pkce = await createPkce();
  const now = options.now();
  const pending: PendingLogin = {
    clientId,
    redirectUri,
    codeChallenge: challenge,
    resource,
    csrf: randomHex(16),
    exp: now.getTime() + LOGIN_TTL_MS,
    supabaseVerifier: pkce.verifier,
  };
  if (state !== undefined) pending.state = state;
  const cookie = writeCookie(await seal(pending, options.authSecret), options.publicUrl, LOGIN_TTL_MS / 1000);
  return redirectTo(`${options.publicUrl}/oauth/login`, cookie);
}

async function showLogin(request: Request, options: OAuthServerOptions): Promise<Response> {
  const pending = await pendingFrom(request, options);
  if (!pending?.supabaseVerifier) return page("Authorization failed", "<p>Start again from your client.</p>", 400);
  return loginPage(pending.csrf);
}

async function startProvider(url: URL, request: Request, options: OAuthServerOptions): Promise<Response> {
  const pending = await pendingFrom(request, options);
  const provider = url.searchParams.get("provider") ?? "";
  if (!pending?.supabaseVerifier || url.searchParams.get("csrf") !== pending.csrf) {
    return page("Authorization failed", "<p>Start again from your client.</p>", 400);
  }
  let name: "github" | "google";
  try {
    name = assertProvider(provider);
  } catch {
    return page("Authorization failed", "<p>The provider is GitHub or Google.</p>", 400);
  }
  const challenge = await s256(pending.supabaseVerifier);
  const location = supabaseAuthorizeUrl({
    supabaseUrl: options.supabaseUrl,
    anonKey: options.anonKey,
    provider: name,
    redirectTo: `${options.publicUrl}/oauth/callback`,
    challenge,
  });
  return redirectTo(location, null);
}

async function callback(url: URL, request: Request, options: OAuthServerOptions): Promise<Response> {
  const pending = await pendingFrom(request, options);
  if (!pending?.supabaseVerifier) return page("Login failed", "<p>Start again from your client.</p>", 400);
  if (url.searchParams.get("error")) return finish(page("Login failed", "<p>Login was declined.</p>", 400), options);
  const code = url.searchParams.get("code");
  if (!code) return finish(page("Login failed", "<p>Login was declined.</p>", 400), options);
  const session = await exchangeSupabaseCode({
    fetch: options.fetch,
    supabaseUrl: options.supabaseUrl,
    anonKey: options.anonKey,
    code,
    verifier: pending.supabaseVerifier,
    now: options.now(),
  });
  const memberships = await options.store.memberships(session.userId);
  const next: PendingLogin = { ...pending, userId: session.userId, exp: options.now().getTime() + LOGIN_TTL_MS };
  delete next.supabaseVerifier;
  if (memberships.length === 0) {
    return finish(page("No organization", "<p>You are not a member of an organization yet.</p>", 400), options);
  }
  const client = await options.store.findClient(next.clientId);
  if (!client?.redirectUris.includes(next.redirectUri)) {
    return finish(page("Authorization failed", "<p>The client is no longer registered.</p>", 400), options);
  }
  const cookie = writeCookie(await seal(next, options.authSecret), options.publicUrl, LOGIN_TTL_MS / 1000);
  return withSetCookie(orgPage(memberships, next.csrf, client.name, next.redirectUri), cookie);
}

async function chooseOrg(request: Request, options: OAuthServerOptions): Promise<Response> {
  const pending = await pendingFrom(request, options);
  const form = await readForm(request);
  if (!pending?.userId || form.get("csrf") !== pending.csrf) {
    return page("Authorization failed", "<p>Start again from your client.</p>", 400);
  }
  const decision = form.get("decision");
  if (decision === "cancel") {
    const client = await options.store.findClient(pending.clientId);
    if (!client?.redirectUris.includes(pending.redirectUri)) {
      return finish(page("Authorization failed", "<p>The client is no longer registered.</p>", 400), options);
    }
    return finish(failRedirect(pending.redirectUri, "access_denied", "Authorization was declined.", pending.state), options);
  }
  if (decision !== "allow") return page("Authorization failed", "<p>Choose Allow or Cancel.</p>", 400);
  const orgId = form.get("org") ?? "";
  return sendCode(pending, orgId, options);
}

async function sendCode(pending: PendingLogin, orgId: string, options: OAuthServerOptions): Promise<Response> {
  if (!pending.userId)
    return finish(page("Authorization failed", "<p>Start again from your client.</p>", 400), options);
  const client = await options.store.findClient(pending.clientId);
  if (!client?.redirectUris.includes(pending.redirectUri)) {
    return finish(page("Authorization failed", "<p>The client is no longer registered.</p>", 400), options);
  }
  const member = await options.store.membership(pending.userId, orgId);
  if (!member)
    return finish(page("No organization", "<p>You are not a member of that organization.</p>", 400), options);
  const now = options.now();
  const code = generateCode();
  await options.store.insertCode({
    hash: await sha256Hex(code),
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    userId: pending.userId,
    orgId,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  });
  const location = new URL(pending.redirectUri);
  location.searchParams.set("code", code);
  if (pending.state) location.searchParams.set("state", pending.state);
  return redirectTo(location.toString(), clearCookie(options.publicUrl));
}

async function token(request: Request, options: OAuthServerOptions): Promise<Response> {
  const form = await readForm(request);
  const grant = form.get("grant_type");
  if (grant === "authorization_code") return codeGrant(form, options);
  if (grant === "refresh_token") return refreshGrant(form, options);
  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

async function codeGrant(form: URLSearchParams, options: OAuthServerOptions): Promise<Response> {
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const client = await options.store.findClient(clientId);
  if (!client?.redirectUris.includes(redirectUri))
    return oauthError(400, "invalid_grant", "The client or redirect URI does not match.");
  if (!sameResource(form.get("resource") ?? "", resourceUrl(options.publicUrl))) {
    return oauthError(400, "invalid_target", "resource must be this server's MCP endpoint.");
  }
  const now = options.now();
  const hash = await sha256Hex(code);
  const stored = await options.store.findCode(hash, now.toISOString());
  if (!stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
    return oauthError(400, "invalid_grant", "The authorization code is invalid.");
  }
  if (!(await pkceMatches(verifier, stored.codeChallenge))) {
    return oauthError(400, "invalid_grant", "The PKCE verifier does not match.");
  }
  if (!(await options.store.consumeCode(hash, now.toISOString()))) {
    return oauthError(400, "invalid_grant", "The authorization code is invalid.");
  }
  const member = await options.store.membership(stored.userId, stored.orgId);
  if (!member) return oauthError(400, "invalid_grant", "You are not a member of that organization.");
  return tokenResponse(await issuePair(options.store, stored.userId, stored.orgId, clientId, now));
}

async function refreshGrant(form: URLSearchParams, options: OAuthServerOptions): Promise<Response> {
  const presented = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  if (bearerKind(presented) !== "refresh") return oauthError(400, "invalid_grant", "The refresh token is invalid.");
  if (!sameResource(form.get("resource") ?? "", resourceUrl(options.publicUrl))) {
    return oauthError(400, "invalid_target", "resource must be this server's MCP endpoint.");
  }
  const now = options.now();
  const hash = await sha256Hex(presented);
  const row = await options.store.findTokenByHash("mcp", hash);
  const bound = row ? refreshClientId(row.label) : null;
  if (!row || row.revokedAt !== null || bound !== clientId || !fresh(row.createdAt, now, REFRESH_TOKEN_TTL_MS)) {
    return oauthError(400, "invalid_grant", "The refresh token is invalid.");
  }
  if (!(await options.store.revokeTokenByHash("mcp", hash, now.toISOString()))) {
    return oauthError(400, "invalid_grant", "The refresh token is invalid.");
  }
  const member = await options.store.membership(row.userId, row.orgId);
  if (!member) return oauthError(400, "invalid_grant", "You are not a member of that organization.");
  return tokenResponse(await issuePair(options.store, row.userId, row.orgId, clientId, now));
}

async function revoke(request: Request, options: OAuthServerOptions): Promise<Response> {
  const form = await readForm(request);
  const presented = form.get("token") ?? "";
  const kind = bearerKind(presented);
  const now = options.now().toISOString();
  if (kind === "service") await options.store.revokeTokenByHash("service", await sha256Hex(presented), now);
  if (kind === "access" || kind === "refresh") {
    await options.store.revokeTokenByHash("mcp", await sha256Hex(presented), now);
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

async function issuePair(
  store: AuthStore,
  userId: string,
  orgId: string,
  clientId: string,
  now: Date,
): Promise<{ access: string; refresh: string }> {
  const access = generateToken("access");
  const refresh = generateToken("refresh");
  const createdAt = now.toISOString();
  await store.insertToken("mcp", { userId, orgId, hash: await sha256Hex(access), label: "access", createdAt });
  try {
    await store.insertToken("mcp", {
      userId,
      orgId,
      hash: await sha256Hex(refresh),
      label: refreshLabel(clientId),
      createdAt,
    });
  } catch (error) {
    await store.revokeTokenByHash("mcp", await sha256Hex(access), createdAt);
    throw error;
  }
  return { access, refresh };
}

function tokenResponse(tokens: { access: string; refresh: string }): Response {
  return json({
    access_token: tokens.access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: tokens.refresh,
    scope: OAUTH_SCOPE,
  });
}

async function pendingFrom(request: Request, options: OAuthServerOptions): Promise<PendingLogin | null> {
  const value = readCookie(request.headers.get("cookie"));
  if (!value) return null;
  return openSeal(value, options.authSecret, options.now());
}

function sameResource(given: string, expected: string): boolean {
  try {
    const left = new URL(given);
    const right = new URL(expected);
    const path = (value: string) => (value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value);
    return left.origin === right.origin && path(left.pathname) === path(right.pathname) && left.search === right.search;
  } catch {
    return false;
  }
}

function finish(response: Response, options: OAuthServerOptions): Response {
  return withSetCookie(response, clearCookie(options.publicUrl));
}

function redirectTo(location: string, cookie: string | null): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function withSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

function methodNotAllowed(): Response {
  return oauthError(405, "invalid_request", "That method is not allowed.");
}

function oauthError(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status);
}

function failRedirect(redirectUri: string, error: string, description: string, state: string | undefined): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirectTo(url.toString(), null);
}

function json(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

function cors(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of cors()) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const text = await readBoundedText(request, 8192);
  return new URLSearchParams(text);
}

async function readJson(request: Request): Promise<unknown> {
  const text = await readBoundedText(request, 8192);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    list.push(item);
  }
  return list;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
