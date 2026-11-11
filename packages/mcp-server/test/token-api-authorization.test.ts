import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken, generateToken, sha256Hex } from "@armada/auth";
import type { VaultStore } from "@armada/core";
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
  const dto = (await created.json()) as { id: string; token: string; orgName: string };
  expect(dto.orgName).toBe("Alpha");
  expect(dto.token).toMatch(/^armada_/);
  const list = await call("token/list", jwt(ALICE));
  expect(list.status).toBe(200);
  expect((await list.json()) as unknown).toMatchObject({ tokens: [{ id: dto.id, orgName: "Alpha", label: "worker" }] });

  const legacySelector = await call("token/create", jwt(ALICE), { orgName: "Beta" });
  expect(legacySelector.status).toBe(200);
  expect(((await legacySelector.json()) as { orgName: string }).orgName).toBe("Beta");
  const uuidSelector = await call("token/create", jwt(ALICE), { org: ORG_A });
  expect(uuidSelector.status).toBe(200);
  expect(((await uuidSelector.json()) as { orgName: string }).orgName).toBe("Alpha");
  const switched = await call("token/create", jwt(ALICE), { org: "Other" });
  expect(switched.status).toBe(403);
});

test("service tokens remain subset-scoped and cannot create or list in another organization", async () => {
  const { call, store } = makeServer();
  const parent = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const child = await call("token/create", parent.token, { org: "Alpha", label: "child" });
  expect(child.status).toBe(200);
  const escalation = await call("token/create", parent.token, { org: "Beta", label: "escape" });
  expect(escalation.status).toBe(403);
  const unscoped = await call("token/create", parent.token, { label: "escape" });
  expect(unscoped.status).toBe(403);
  const list = await call("token/list", parent.token);
  expect(list.status).toBe(200);
  const tokens = ((await list.json()) as { tokens: { orgName: string }[] }).tokens;
  expect(tokens).toHaveLength(2);
  expect(tokens.every((token) => token.orgName === "Alpha")).toBe(true);
});

test("only an owner can revoke their service token, including for an organization they administer", async () => {
  const { call, store } = makeServer();
  const aliceToken = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const bobToken = await createServiceToken(store, { userId: BOB, orgName: "Alpha", now: now() });
  const denied = await call("token/revoke", jwt(ALICE), { id: bobToken.id });
  expect(denied.status).toBe(403);
  const revoked = await call("token/revoke", jwt(ALICE), { id: aliceToken.id });
  expect(revoked.status).toBe(200);
  const parent = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const serviceDenied = await call("token/revoke", parent.token, { id: bobToken.id });
  expect(serviceDenied.status).toBe(403);
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

test("an Alpha-scoped service token cannot list or revoke Alice's Beta token", async () => {
  const { call, store } = makeServer();
  const alpha = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const beta = await createServiceToken(store, { userId: ALICE, orgName: "Beta", now: now() });
  const list = await call("token/list", alpha.token);
  expect(list.status).toBe(200);
  const ids = ((await list.json()) as { tokens: { id: string }[] }).tokens.map((token) => token.id);
  expect(ids).toContain(alpha.id);
  expect(ids).not.toContain(beta.id);
  const revoke = await call("token/revoke", alpha.token, { id: beta.id });
  expect(revoke.status).toBe(403);
});

test("database organization names are globally unique, preventing duplicate-name scope confusion", () => {
  const migration = Bun.file("supabase/migrations/20261108160000_orgs_credentials.sql");
  return migration.text().then((sql) => {
    expect(sql).toContain("create unique index orgs_name_key on public.orgs (lower(btrim(name)))");
  });
});

test("MCP OAuth access tokens are restricted to their Alpha scope on every token route", async () => {
  const { call, store } = makeServer();
  const access = await oauthAccess(store, ORG_A);
  const alpha = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
  const beta = await createServiceToken(store, { userId: ALICE, orgName: "Beta", now: now() });

  const unscoped = await call("token/create", access, { label: "child" });
  expect(unscoped.status).toBe(403);
  const betaChild = await call("token/create", access, { org: "Beta", label: "child" });
  expect(betaChild.status).toBe(403);
  const list = await call("token/list", access);
  expect(list.status).toBe(200);
  const ids = ((await list.json()) as { tokens: { id: string }[] }).tokens.map((token) => token.id);
  expect(ids).toContain(alpha.id);
  expect(ids).not.toContain(beta.id);
  const revoke = await call("token/revoke", access, { id: beta.id });
  expect(revoke.status).toBe(403);
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
      const response = await call(route, jwt(ALICE), { org: "Alpha", id: "missing" });
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
  ] as const) {
    const response = await call(route, jwt(ALICE), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
  }
});

test("route-local membership failures remain dependency failures after scoped authentication", async () => {
  for (const route of ["token/list", "token/create", "token/revoke"]) {
    const { call, store } = makeServer();
    const parent = await createServiceToken(store, { userId: ALICE, orgName: "Alpha", now: now() });
    const memberships = store.memberships.bind(store);
    let reads = 0;
    store.memberships = async (userId) => {
      if (++reads > 0) throw new Error("private database diagnostic");
      return memberships(userId);
    };
    const response = await call(route, parent.token, { org: "Alpha", id: parent.id });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database diagnostic");
  }
});
