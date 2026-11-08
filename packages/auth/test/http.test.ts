import { describe, expect, test } from "bun:test";
import { createUserStore } from "../src/http.ts";
import { ORG_ID, USER_ID } from "./prove.ts";

const HASH = "ab".repeat(32);
const TOKEN_ID = "11111111-1111-4111-8111-111111111111";

describe("user store", () => {
  test("a user JWT never selects, filters or returns the hash column of a token", async () => {
    const seen: Array<{ method: string; path: string; params: URLSearchParams; body: unknown }> = [];
    const row = {
      id: TOKEN_ID,
      user_id: USER_ID,
      org_id: ORG_ID,
      label: "worker",
      revoked_at: null,
      created_at: "2026-11-08T00:00:00.000Z",
    };
    const store = createUserStore({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      accessToken: "user-jwt",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seen.push({
          method: init?.method ?? "GET",
          path: url.pathname.replace("/rest/v1/", ""),
          params: url.searchParams,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json([{ ...row, orgs: { name: "Example" } }]);
      },
    });

    await store.insertToken("service", {
      userId: USER_ID,
      orgId: ORG_ID,
      hash: HASH,
      label: "worker",
      createdAt: "2026-11-08T00:00:00.000Z",
    });
    await store.revokeToken("service", { id: TOKEN_ID, userId: USER_ID, revokedAt: "2026-11-08T01:00:00.000Z" });
    await store.listServiceTokens(USER_ID);

    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST service_tokens",
      "PATCH service_tokens",
      "GET service_tokens",
    ]);
    for (const request of seen) {
      // PostgREST returns every column unless `select` names them, and a column filter or order reads it too.
      const selected = request.params.get("select") ?? "*";
      expect(selected.split(",")).not.toContain("*");
      expect(selected.split(",")).not.toContain("hash");
      expect([...request.params.keys()]).not.toContain("hash");
      expect(request.params.get("order") ?? "").not.toContain("hash");
    }
    // The hash goes in as a value of the insert, which is all a user JWT may do with it.
    expect(seen[0]?.body).toMatchObject({ hash: HASH });
  });
});
