import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { VERSION } from "@armada/core";
import { accountOperations } from "@armada/core/contract";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const authorization = `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`;

function accountSession() {
  const authStore = createMemoryAuthStore();
  const requests: { url: string; method: string | undefined; authorization: string | null }[] = [];
  const post = (path: string) =>
    handleControlRequest(
      new Request(`https://armada.test${path}`, { method: "POST", headers: { authorization }, body: "{}" }),
      {
        authStore,
        store: createSqlVaultStore({
          query: async () => {
            throw new Error("Account session routes do not need vault storage.");
          },
        }),
        encryptionKey: undefined,
        supabase: {
          supabaseUrl: "https://supabase.test",
          anonKey: "anon",
          fetch: async (input, init) => {
            requests.push({
              url: String(input),
              method: init?.method,
              authorization: new Headers(init?.headers).get("authorization"),
            });
            return init?.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ id: userId });
          },
        },
      },
    );
  return { authStore, post, requests };
}

test("account status returns the signed-in caller's identity and memberships", async () => {
  const { authStore, post } = accountSession();
  const orgId = "22222222-2222-4222-8222-222222222222";
  authStore.addMembership(userId, { orgId, name: "Team", role: "member" });
  const response = await post("/api/v1/account/status");

  expect(response?.status).toBe(200);
  const { output, successHeaders } = accountOperations.readAccountStatus;
  successHeaders["Cache-Control"].parse(response?.headers.get("cache-control"));
  expect(output.parse(await response?.json())).toEqual({
    userId,
    orgs: [{ orgId, role: "member" }],
    authentication: "supabase",
    version: VERSION,
  });
});

test("account logout revokes the authenticated Supabase session", async () => {
  const { post, requests } = accountSession();
  const response = await post("/api/v1/account/logout");

  expect(requests).toEqual([
    { url: "https://supabase.test/auth/v1/user", method: undefined, authorization },
    { url: "https://supabase.test/auth/v1/logout?scope=local", method: "POST", authorization },
  ]);
  expect(response?.status).toBe(200);
  const { output, successHeaders } = accountOperations.logoutAccount;
  successHeaders["Cache-Control"].parse(response?.headers.get("cache-control"));
  output.parse(await response?.json());
});
