import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import { createSqlVaultStore } from "@armada/core/server";
import { handleControlRequest } from "../src/control.ts";

test("account logout revokes the authenticated Supabase session", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const authorization = `Bearer eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: userId })).replace(/=+$/, "")}.sig`;
  const requests: { url: string; method: string | undefined; authorization: string | null }[] = [];
  const response = await handleControlRequest(
    new Request("https://armada.test/api/v1/account/logout", {
      method: "POST",
      headers: { authorization },
      body: "{}",
    }),
    {
      authStore: createMemoryAuthStore(),
      store: createSqlVaultStore({
        query: async () => {
          throw new Error("Account logout does not need vault storage.");
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

  expect(requests).toEqual([
    { url: "https://supabase.test/auth/v1/user", method: undefined, authorization },
    { url: "https://supabase.test/auth/v1/logout?scope=local", method: "POST", authorization },
  ]);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ ok: true });
});
