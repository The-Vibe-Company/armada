import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken, generateToken, sha256Hex } from "@armada/auth";
import type { VaultStore } from "@armada/core";
import { tokenOperations } from "@armada/core/contract";
import { type ControlOptions, createHandler, handleControlRequest } from "../src/index.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = () => new Date("2026-11-08T00:00:00.000Z");

function jwt(userId: string) {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`;
}

async function oauthAccess(store: ReturnType<typeof createMemoryAuthStore>, orgId: string) {
  const token = generateToken("access");
  await store.insertToken("mcp", {
    userId: ALICE,
    orgId,
    hash: await sha256Hex(token),
    label: "access",
    createdAt: now().toISOString(),
  });
  return token;
}

function makeServer() {
  const store = createMemoryAuthStore();
  store.addMembership(ALICE, { orgId: ORG_A, name: "Alpha", role: "admin" });
  store.addMembership(ALICE, { orgId: ORG_B, name: "Beta", role: "member" });
  store.addMembership(BOB, { orgId: ORG_A, name: "Alpha", role: "member" });
  const supabaseFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "");
    const payload = token?.split(".")[1];
    let id: unknown;
    try {
      id = payload ? JSON.parse(atob(payload)).sub : undefined;
    } catch {
      id = undefined;
    }
    return typeof id === "string" ? Response.json({ id }) : new Response(null, { status: 401 });
  };
  const options: ControlOptions = {
    authStore: store,
    supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon", fetch: supabaseFetch },
    store: {} as VaultStore,
    encryptionKey: undefined,
    now,
  };
  const handler = createHandler({
    publicUrl: "https://armada.test",
    oauth: {} as never,
    authStore: store,
    supabase: options.supabase,
    data: (() => ({})) as never,
    vault: {} as never,
    encryptionKey: undefined,
    providerFor: (() => ({})) as never,
    routes: [(request) => handleControlRequest(request, options)],
    now,
  });
  const call = (path: string, token?: string, body: Record<string, unknown> = {}) =>
    handler(
      new Request(`https://armada.test/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  return { call, store };
}

test("token routes refuse anonymous callers and list never exposes secrets or hashes", async () => {
  const { call, store } = makeServer();
  const owned = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  for (const route of ["token/list", "token/create", "token/revoke"]) {
    const response = await call(route);
    expect([401, 403]).toContain(response.status);
  }
  const response = await call("token/list", jwt(ALICE));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(owned.token);
  expect(text).not.toContain("hash");
  expect(text).toContain(owned.id);
});

test("session callers can create and list only their own tokens in memberships", async () => {
  const { call } = makeServer();
  const created = await call("token/create", jwt(ALICE), { org: "Alpha", label: "worker" });
  expect(created.status).toBe(200);
  tokenOperations.createServiceToken.successHeaders["Cache-Control"].parse(created.headers.get("cache-control"));
  const dto = tokenOperations.createServiceToken.output.parse(await created.json());
  expect(dto.orgName).toBe("Alpha");
  expect(dto.expiresAt).toBe("2026-12-08T00:00:00.000Z");
  expect(dto.token).toMatch(/^armada_sk_[A-Za-z0-9_-]{43}$/);
  const list = await call("token/list", jwt(ALICE));
  expect(list.status).toBe(200);
  tokenOperations.listServiceTokens.successHeaders["Cache-Control"].parse(list.headers.get("cache-control"));
  expect(tokenOperations.listServiceTokens.output.parse(await list.json())).toMatchObject({
    tokens: [{ id: dto.id, orgName: "Alpha", label: "worker", lastUsedAt: null, expiresAt: dto.expiresAt }],
  });

  const uuidSelector = await call("token/create", jwt(ALICE), { org: ORG_A, label: "uuid-key", expires: "never" });
  expect(uuidSelector.status).toBe(200);
  expect(await uuidSelector.json()).toMatchObject({ orgName: "Alpha", expiresAt: null });
  const switched = await call("token/create", jwt(ALICE), { org: "Other", label: "worker" });
  expect(switched.status).toBe(403);
});

test("service and MCP tokens cannot manage API keys", async () => {
  const { call, store } = makeServer();
  const key = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const access = await oauthAccess(store, ORG_A);
  for (const token of [key.token, access]) {
    expect((await call("token/create", token, { org: "Alpha", label: "child" })).status).toBe(403);
    expect((await call("token/list", token)).status).toBe(403);
    expect((await call("token/revoke", token, { id: key.id })).status).toBe(403);
  }
});

test("whoami identifies the verified login or API key and rejects a revoked key", async () => {
  const { call, store } = makeServer();
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const key = await createServiceToken(store, {
    userId: ALICE,
    orgName: "Alpha",
    label: "agent",
    expiresAt,
    now: now(),
  });
  const login = await call("token/whoami", jwt(ALICE));
  expect(tokenOperations.whoami.output.parse(await login.json())).toEqual({ userId: ALICE, auth: "login" });
  const identity = await call("token/whoami", key.token);
  expect(tokenOperations.whoami.output.parse(await identity.json())).toEqual({
    userId: ALICE,
    auth: "key",
    key: { name: "agent", expiresAt },
  });
  expect((await call("token/revoke", jwt(ALICE), { id: key.id })).status).toBe(200);
  const refused = await call("token/whoami", key.token);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining("expired, or revoked") } });
});

test("only an owner can revoke their service token, including for an organization they administer", async () => {
  const { call, store } = makeServer();
  const aliceToken = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const bobToken = await createServiceToken(store, { userId: BOB, orgName: "Alpha", now: now() });
  const denied = await call("token/revoke", jwt(ALICE), { id: bobToken.id });
  expect(denied.status).toBe(403);
  const revoked = await call("token/revoke", jwt(ALICE), { id: aliceToken.id });
  expect(revoked.status).toBe(200);
  tokenOperations.revokeServiceToken.successHeaders["Cache-Control"].parse(revoked.headers.get("cache-control"));
  expect(tokenOperations.revokeServiceToken.output.parse(await revoked.json())).toEqual({ ok: true });
});

test("session token lists hide another member's tokens even in the same organization", async () => {
  const { call, store } = makeServer();
  const alice = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const bob = await createServiceToken(store, { userId: BOB, orgName: "Alpha", now: now() });
  const list = await call("token/list", jwt(ALICE));
  expect(list.status).toBe(200);
  const ids = ((await list.json()) as { tokens: { id: string }[] }).tokens.map((token) => token.id);
  expect(ids).toContain(alice.id);
  expect(ids).not.toContain(bob.id);
});

test("token routes distinguish auth-store outages, post-auth I/O and invalid requests", async () => {
  for (const route of ["token/list", "token/create", "token/revoke"]) {
    for (const phase of ["auth", "operation"] as const) {
      const { call, store } = makeServer();
      if (phase === "auth") {
        store.memberships = async () => {
          throw new Error("private database diagnostic");
        };
      } else {
        const fail = async () => {
          throw new Error("private database diagnostic");
        };
        if (route === "token/list") store.listServiceTokens = fail;
        if (route === "token/create") store.insertToken = fail;
        if (route === "token/revoke") store.revokeToken = fail;
      }
      const body = route === "token/create" ? { org: "Alpha", label: "key" } : { id: BOB };
      const response = await call(route, jwt(ALICE), body);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "dependency_unavailable" } });
    }
  }
  const { call } = makeServer();
  for (const [route, body] of [
    ["token/create", { org: 1 }],
    ["token/create", { org: "Alpha", label: " " }],
    ["token/revoke", {}],
    ["token/revoke", { id: "not-a-uuid" }],
  ] as const) {
    const response = await call(route, jwt(ALICE), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
  }
});
