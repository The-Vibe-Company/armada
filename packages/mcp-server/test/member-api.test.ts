import { expect, test } from "bun:test";
import { createMemoryAuthStore, createServiceToken } from "@armada/auth";
import { memberOperations } from "@armada/core/contract";
import type { VaultStore } from "@armada/core/server";
import adminOpenApi from "../openapi-admin.json";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

const org = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Example", role: "admin" } as const;
const admin = "11111111-1111-4111-8111-111111111111";
const account = { id: "22222222-2222-4222-8222-222222222222", email: "new@example.test" };
const existingMember = { userId: admin, email: null, role: "admin", createdAt: "2026-11-20T00:00:00Z" } as const;

function memberApi(overrides: Partial<VaultStore> = {}) {
  const now = () => new Date("2026-11-20T00:00:00Z");
  const authStore = createMemoryAuthStore();
  authStore.addMembership(admin, { orgId: org.id, name: org.name, role: org.role });
  const store = {
    memberships: async () => [org],
    listMembers: async () => [existingMember],
    findUserByEmail: async () => account,
    ...overrides,
  } satisfies Partial<VaultStore>;
  const options: ControlOptions = {
    authStore,
    store: store as VaultStore,
    supabase: {
      supabaseUrl: "https://supabase.test",
      anonKey: "placeholder",
      fetch: async () => Response.json({ id: admin }),
    },
    encryptionKey: undefined,
    now,
  };
  const call = (path: string, body?: object, bearer = "eyJhbGciOiJIUzI1NiJ9.e30.sig") =>
    handleControlRequest(
      new Request(`https://armada.test/api/v1/members/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      }),
      options,
    );
  return { call, serviceToken: () => createServiceToken(authStore, { userId: admin, orgName: org.name, now: now() }) };
}

test("member listing accepts an empty body and publishes a nullable email", async () => {
  const response = await memberApi().call("list");
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(memberOperations.listMembers.output.parse(await response?.json())).toEqual({
    org,
    members: [existingMember],
  });
});

test("adding a member defaults a null role and returns the saved membership", async () => {
  const member = { ...existingMember, userId: account.id, email: account.email, role: "member" } as const;
  const response = await memberApi({
    findUserByEmail: async (email) => {
      expect(email).toBe(account.email);
      return account;
    },
    addMember: async (orgId, userId, role) => {
      expect([orgId, userId, role]).toEqual([org.id, account.id, "member"]);
      return true;
    },
    listMembers: async () => [existingMember, member],
  }).call("add", { email: `  ${account.email} `, role: null });
  expect(response?.status).toBe(200);
  expect(memberOperations.addMember.output.parse(await response?.json())).toEqual({ member });
});

test("changing a member role requires a role and returns an acknowledgement", async () => {
  const { call } = memberApi({
    setMemberRole: async (orgId, userId, role) => {
      expect([orgId, userId, role]).toEqual([org.id, account.id, "admin"]);
      return true;
    },
  });
  const invalid = await call("role", { email: account.email });
  expect(invalid?.status).toBe(400);
  expect(await invalid?.json()).toMatchObject({ error: { code: "invalid", message: "role is required." } });
  const response = await call("role", { email: account.email, role: "admin" });
  expect(response?.status).toBe(200);
  expect(memberOperations.setMemberRole.output.parse(await response?.json())).toEqual({ ok: true });
});

test("removing a member returns an acknowledgement", async () => {
  const response = await memberApi({
    removeMember: async (orgId, userId) => {
      expect([orgId, userId]).toEqual([org.id, account.id]);
      return true;
    },
  }).call("remove", { email: account.email });
  expect(response?.status).toBe(200);
  expect(memberOperations.removeMember.output.parse(await response?.json())).toEqual({ ok: true });
});

test("a scoped bearer cannot address another organization even with invalid mutation fields", async () => {
  const { call, serviceToken } = memberApi();
  const { token } = await serviceToken();
  const response = await call("role", { org: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, token);
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ error: { code: "forbidden" } });
});

test("published member mutation requests accept padded email addresses and reject malformed ones", () => {
  for (const path of ["/api/v1/members/add", "/api/v1/members/role", "/api/v1/members/remove"] as const) {
    const { email } = adminOpenApi.paths[path].post.requestBody.content["application/json"].schema.properties;
    expect(email.pattern).toBeDefined();
    const pattern = new RegExp(email.pattern);
    expect(`  ${account.email} `).toMatch(pattern);
    expect("not-an-email").not.toMatch(pattern);
  }
});
