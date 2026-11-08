import { describe, expect, test } from "bun:test";
import { createMemoryAuthStore } from "../src/memory.ts";
import { handleOAuthRequest } from "../src/oauth.ts";
import { createPkce, s256 } from "../src/pkce.ts";
import type { AuthFetch } from "../src/types.ts";
import { ORG_ID, proveAuth, USER_ID } from "./prove.ts";

const PUBLIC = "http://127.0.0.1:8080";

describe("oauth", () => {
  test("a client logs in with OAuth and a revoked service token is refused", async () => {
    const store = createMemoryAuthStore();
    store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
    const clock = { at: new Date("2026-11-08T00:00:00.000Z") };
    await proveAuth({
      store,
      now: () => clock.at,
      advance: (ms) => {
        clock.at = new Date(clock.at.getTime() + ms);
      },
      snapshot: async () => store.debugSnapshot(),
    });
  });

  test("two orgs ask the user to choose", async () => {
    const store = createMemoryAuthStore();
    const other = "00000000-0000-4000-8000-000000000011";
    store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
    store.addMembership(USER_ID, { orgId: other, name: "Other", role: "member" });
    const pkce = await createPkce();
    let challenge = "";
    const server = {
      store,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { code_verifier?: string };
        if (!body.code_verifier || (await s256(body.code_verifier)) !== challenge)
          return new Response("no", { status: 400 });
        return Response.json({
          access_token: "supabase-access-token",
          refresh_token: "supabase-refresh-token",
          expires_in: 3600,
          user: { id: USER_ID },
        });
      }) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: "test-secret-at-least-16",
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    const registered = await handleOAuthRequest(
      new Request(`${PUBLIC}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
      }),
      server,
    );
    const client = (await registered?.json()) as { client_id: string };
    const authorize = await handleOAuthRequest(
      new Request(
        `${PUBLIC}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&code_challenge=${pkce.challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
      ),
      server,
    );
    const cookie = authorize?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const login = await handleOAuthRequest(new Request(`${PUBLIC}/oauth/login`, { headers: { cookie } }), server);
    const href = /href="([^"]+)"/.exec((await login?.text()) ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    const start = await handleOAuthRequest(new Request(`${PUBLIC}${href}`, { headers: { cookie } }), server);
    challenge = new URL(start?.headers.get("location") ?? "").searchParams.get("code_challenge") ?? "";
    const callback = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/callback?code=ok`, { headers: { cookie } }),
      server,
    );
    expect(callback?.status).toBe(200);
    const html = await callback?.text();
    expect(html).toContain("Example");
    expect(html).toContain("Other");
    const nextCookie = callback?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(html ?? "")?.[1] ?? "";
    const chosen = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/org`, {
        method: "POST",
        headers: { cookie: nextCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, org: other }).toString(),
      }),
      server,
    );
    expect(chosen?.status).toBe(302);
    expect(new URL(chosen?.headers.get("location") ?? "").searchParams.get("code")).toBeTruthy();
    expect(store.debugSnapshot()).not.toContain("supabase-access-token");
  });
});
