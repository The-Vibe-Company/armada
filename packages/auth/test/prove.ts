import { expect } from "bun:test";
import { sha256Hex } from "../src/codec.ts";
import { ACCESS_TOKEN_TTL_MS } from "../src/limits.ts";
import { handleOAuthRequest, type OAuthServerOptions } from "../src/oauth.ts";
import { createPkce, s256 } from "../src/pkce.ts";
import { createServiceToken, revokeServiceToken } from "../src/service-tokens.ts";
import type { AuthFetch, AuthStore } from "../src/types.ts";
import { authenticate } from "../src/verify.ts";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const STRANGER_ID = "00000000-0000-4000-8000-000000000002";
export const ORG_ID = "00000000-0000-4000-8000-000000000010";
const PUBLIC = "http://127.0.0.1:8080";
const REDIRECT = "http://127.0.0.1:9999/callback";

/**
 * The OAuth and service-token behaviour both stores must keep.
 * `snapshot` is everything persisted: it must contain hashes and never a raw token.
 */
export async function proveAuth(options: {
  store: AuthStore;
  now: () => Date;
  advance: (ms: number) => void;
  snapshot: () => Promise<string>;
}): Promise<void> {
  const secrets: string[] = [];
  let expectedChallenge = "";
  const fetchImpl: AuthFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { auth_code?: string; code_verifier?: string };
    if (body.code_verifier) secrets.push(body.code_verifier);
    if (body.auth_code) secrets.push(body.auth_code);
    if (!body.code_verifier || (await s256(body.code_verifier)) !== expectedChallenge) {
      return new Response("no", { status: 400 });
    }
    const userId = body.auth_code === "stranger-code" ? STRANGER_ID : USER_ID;
    secrets.push("supabase-access-token", "supabase-refresh-token");
    return Response.json({
      access_token: "supabase-access-token",
      refresh_token: "supabase-refresh-token",
      expires_in: 3600,
      user: { id: userId },
    });
  };
  const server: OAuthServerOptions = {
    store: options.store,
    fetch: fetchImpl,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon-test",
    authSecret: "test-secret-at-least-16",
    publicUrl: PUBLIC,
    now: options.now,
  };
  const jar = new Jar();

  async function send(
    method: string,
    path: string,
    body?: { json?: unknown; form?: URLSearchParams },
  ): Promise<Response> {
    let verb = method;
    let target = path;
    let payload = body;
    for (let hop = 0; hop < 6; hop += 1) {
      const headers = new Headers();
      if (jar.header()) headers.set("cookie", jar.header());
      let raw: string | undefined;
      if (payload && hop === 0) {
        if (payload.json !== undefined) {
          headers.set("content-type", "application/json");
          raw = JSON.stringify(payload.json);
        } else if (payload.form) {
          headers.set("content-type", "application/x-www-form-urlencoded");
          raw = payload.form.toString();
        }
      }
      const response = await handleOAuthRequest(
        new Request(`${PUBLIC}${target}`, { method: verb, headers, body: raw }),
        server,
      );
      if (!response) throw new Error(`not an auth route ${target}`);
      jar.set(response);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, PUBLIC);
      if (next.origin !== new URL(PUBLIC).origin) return response;
      verb = "GET";
      target = `${next.pathname}${next.search}`;
      payload = undefined;
    }
    throw new Error("too many redirects");
  }

  const metadata = await send("GET", "/.well-known/oauth-protected-resource");
  expect(metadata.status).toBe(200);
  const resource = (await metadata.json()) as { resource: string; authorization_servers: string[] };
  expect(resource).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
  const serverMeta = (await (await send("GET", "/.well-known/oauth-authorization-server")).json()) as {
    code_challenge_methods_supported: string[];
    registration_endpoint: string;
  };
  expect(serverMeta.code_challenge_methods_supported).toEqual(["S256"]);
  expect(serverMeta.registration_endpoint).toBe(`${PUBLIC}/register`);

  const rejected = await send("POST", "/register", {
    json: { redirect_uris: ["http://evil.example/callback"], client_name: "Nope" },
  });
  expect(rejected.status).toBe(400);

  const registered = await send("POST", "/register", {
    json: { client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  expect(client.client_id).toMatch(/^[0-9a-f]{32}$/);

  const pkce = await createPkce();
  const redirect = await authorize(send, client.client_id, pkce.challenge, "member-code");
  const issued = new URL(redirect.headers.get("location") ?? "");
  const code = issued.searchParams.get("code");
  expect(issued.origin + issued.pathname).toBe(REDIRECT);
  expect(issued.searchParams.get("state")).toBe("xyz");
  expect(code).toBeTruthy();
  if (!code) throw new Error("missing code");
  secrets.push(code);

  const wrong = await send("POST", "/token", {
    form: tokenForm({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: "a".repeat(43),
    }),
  });
  expect(wrong.status).toBe(400);

  const exchanged = await send("POST", "/token", {
    form: tokenForm({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: pkce.verifier,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; expires_in: number };
  expect(tokens.expires_in).toBe(3600);
  expect(tokens.access_token.startsWith("armada_mcp_")).toBe(true);
  expect(tokens.refresh_token.startsWith("armada_mrt_")).toBe(true);
  secrets.push(tokens.access_token, tokens.refresh_token);

  const reused = await send("POST", "/token", {
    form: tokenForm({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: pkce.verifier,
    }),
  });
  expect(reused.status).toBe(400);

  const authed = await authenticate(`Bearer ${tokens.access_token}`, options.store, options.now());
  expect(authed).toMatchObject({
    ok: true,
    principal: { userId: USER_ID, orgId: ORG_ID, kind: "mcp", role: "admin" },
  });
  expect(await authenticate(`Bearer ${tokens.refresh_token}`, options.store, options.now())).toEqual({
    ok: false,
    error: "invalid_token",
  });

  options.advance(ACCESS_TOKEN_TTL_MS + 1);
  expect(await authenticate(`Bearer ${tokens.access_token}`, options.store, options.now())).toEqual({
    ok: false,
    error: "invalid_token",
  });
  const refreshed = await send("POST", "/token", {
    form: tokenForm({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  expect(refreshed.status).toBe(200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  secrets.push(next.access_token, next.refresh_token);
  expect((await authenticate(`Bearer ${next.access_token}`, options.store, options.now())).ok).toBe(true);
  const replayed = await send("POST", "/token", {
    form: tokenForm({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  expect(replayed.status).toBe(400);

  const revoked = await send("POST", "/revoke", { form: tokenForm({ token: next.access_token }) });
  expect(revoked.status).toBe(200);
  expect(await authenticate(`Bearer ${next.access_token}`, options.store, options.now())).toEqual({
    ok: false,
    error: "invalid_token",
  });

  const created = await createServiceToken(options.store, { userId: USER_ID, label: "dave", now: options.now() });
  secrets.push(created.token);
  expect(created.orgName).toBe("Example");
  expect((await authenticate(`Bearer ${created.token}`, options.store, options.now())).ok).toBe(true);
  await revokeServiceToken(options.store, { userId: USER_ID, id: created.id, now: options.now() });
  expect(await authenticate(`Bearer ${created.token}`, options.store, options.now())).toEqual({
    ok: false,
    error: "invalid_token",
  });
  await expect(
    revokeServiceToken(options.store, { userId: USER_ID, id: created.id, now: options.now() }),
  ).rejects.toThrow(/No active service token/);

  const stranger = await authorize(send, client.client_id, (await createPkce()).challenge, "stranger-code");
  expect(stranger.status).toBe(400);

  const stored = await options.snapshot();
  for (const secret of secrets) expect(stored).not.toContain(secret);
  expect(stored).toContain(await sha256Hex(created.token));
  expect(stored).toContain(await sha256Hex(tokens.access_token));
  expect(stored).not.toContain("armada_sk_");
  expect(stored).not.toContain("armada_mcp_");
  expect(stored).not.toContain("armada_mrt_");

  async function authorize(
    talk: typeof send,
    clientId: string,
    challenge: string,
    authCode: string,
  ): Promise<Response> {
    const login = await talk(
      "GET",
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
    );
    expect(login.status).toBe(200);
    const href = /href="([^"]+)"/.exec(await login.text())?.[1]?.replaceAll("&amp;", "&");
    if (!href) throw new Error("missing provider link");
    const start = await talk("GET", href);
    expect(start.status).toBe(302);
    const location = start.headers.get("location");
    if (!location) throw new Error("missing supabase redirect");
    expectedChallenge = new URL(location).searchParams.get("code_challenge") ?? "";
    expect(new URL(location).searchParams.get("provider")).toBe("github");
    const consent = await talk("GET", `/oauth/callback?code=${authCode}`);
    if (authCode === "stranger-code") return consent;
    expect(consent.status).toBe(200);
    expect(consent.headers.get("location")).toBeNull();
    const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
    if (!csrf) throw new Error("missing consent CSRF");
    return talk("POST", "/oauth/org", { form: new URLSearchParams({ csrf, org: ORG_ID, decision: "allow" }) });
  }
}

function tokenForm(fields: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams(fields);
  form.set("resource", `${PUBLIC}/mcp`);
  return form;
}

class Jar {
  private cookie = "";

  set(response: Response): void {
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const raw of cookies) {
      const pair = raw.split(";")[0] ?? "";
      if (!pair.startsWith("armada_oauth=")) continue;
      const value = pair.slice("armada_oauth=".length);
      this.cookie = value.length === 0 ? "" : `armada_oauth=${value}`;
    }
  }

  header(): string {
    return this.cookie;
  }
}
