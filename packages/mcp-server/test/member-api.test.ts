import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { memberOperations } from "@armada/core/contract";
import type { VaultStore } from "@armada/core/server";
import { type ControlOptions, handleControlRequest } from "../src/control.ts";

const org = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Example", role: "admin" } as const;
const admin = "11111111-1111-4111-8111-111111111111";
const account = { id: "22222222-2222-4222-8222-222222222222", email: "new@example.test" };
const existingMember = { userId: admin, email: null, role: "admin", createdAt: "2026-11-20T00:00:00Z" } as const;

function memberApi(overrides: Partial<VaultStore> = {}) {
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
  };
  return (path: string, body?: object) =>
    handleControlRequest(
      new Request(`https://armada.test/api/v1/members/${path}`, {
        method: "POST",
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" },
        body: JSON.stringify(body),
      }),
      options,
    );
}

test("member listing accepts an empty body and publishes a nullable email", async () => {
  const response = await memberApi()("list");
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
    addMember: async (orgId, userId, role) => {
      expect([orgId, userId, role]).toEqual([org.id, account.id, "member"]);
      return true;
    },
    listMembers: async () => [existingMember, member],
  })("add", { email: account.email, role: null });
  expect(response?.status).toBe(200);
  expect(memberOperations.addMember.output.parse(await response?.json())).toEqual({ member });
});

test("changing a member role requires a role and returns an acknowledgement", async () => {
  const api = memberApi({
    setMemberRole: async (orgId, userId, role) => {
      expect([orgId, userId, role]).toEqual([org.id, account.id, "admin"]);
      return true;
    },
  });
  const invalid = await api("role", { email: account.email });
  expect(invalid?.status).toBe(400);
  expect(await invalid?.json()).toMatchObject({ error: { code: "invalid", message: "role is required." } });
  const response = await api("role", { email: account.email, role: "admin" });
  expect(response?.status).toBe(200);
  expect(memberOperations.setMemberRole.output.parse(await response?.json())).toEqual({ ok: true });
});

test("removing a member returns an acknowledgement", async () => {
  const response = await memberApi({
    removeMember: async (orgId, userId) => {
      expect([orgId, userId]).toEqual([org.id, account.id]);
      return true;
    },
  })("remove", { email: account.email });
  expect(response?.status).toBe(200);
  expect(memberOperations.removeMember.output.parse(await response?.json())).toEqual({ ok: true });
});
