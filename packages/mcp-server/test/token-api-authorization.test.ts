import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken } from "@armada/auth";
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

  const switched = await call("token/create", jwt(ALICE), { org: "Other" });
  expect(switched.status).toBe(401);
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
