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

  test.each([
    { count: 1, action: "allow", status: 302 },
    { count: 2, action: "allow", status: 302 },
    { count: 1, action: "cancel", status: 302 },
    { count: 2, action: "cancel", status: 302 },
    { count: 1, action: "wrong-csrf", status: 400 },
    { count: 2, action: "wrong-org", status: 400 },
    { count: 1, action: "missing-decision", status: 400 },
    { count: 2, action: "stale-client", status: 400 },
    { count: 2, action: "stale-member", status: 400 },
    { count: 1, action: "cancel-stale-client", status: 400 },
    { count: 1, action: "cancel-wrong-csrf", status: 400 },
  ])("$count orgs: $action requires explicit validated consent", async ({ count, action, status }) => {
    const store = createMemoryAuthStore();
    const other = "00000000-0000-4000-8000-000000000011";
    store.addMembership(USER_ID, { orgId: ORG_ID, name: "Example", role: "admin" });
    if (count === 2) store.addMembership(USER_ID, { orgId: other, name: "Other", role: "member" });
    const redirectUri = "cursor://callback/complete";
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
        body: JSON.stringify({ client_name: '<img src=x onerror="alert(1)">', redirect_uris: [redirectUri] }),
      }),
      server,
    );
    const client = (await registered?.json()) as { client_id: string };
    const authorize = await handleOAuthRequest(
      new Request(
        `${PUBLIC}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=original-state&resource=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
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
    if (count === 2) expect(html).toContain("Other");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("cursor://callback");
    expect(html).not.toContain("destination: null");
    expect(html).toContain("does not verify");
    expect(html).toContain("running sandbox commands");
    expect(html).toContain(">Allow</button>");
    expect(html).toContain(">Cancel</button>");
    expect(callback?.headers.get("cache-control")).toBe("no-store");
    expect(callback?.headers.get("location")).toBeNull();
    expect(JSON.parse(store.debugSnapshot())).toMatchObject({ codes: [], tokens: [] });
    if (action.includes("stale-client")) store.findClient = async () => null;
    if (action === "stale-member") store.membership = async () => null;
    const nextCookie = callback?.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(html ?? "")?.[1] ?? "";
    const chosen = await handleOAuthRequest(
      new Request(`${PUBLIC}/oauth/org`, {
        method: "POST",
        headers: { cookie: nextCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf: action.includes("wrong-csrf") ? "incorrect" : csrf,
          org: action === "wrong-org" ? "not-a-membership" : count === 2 ? other : ORG_ID,
          ...(action === "missing-decision" ? {} : { decision: action.startsWith("cancel") ? "cancel" : "allow" }),
        }).toString(),
      }),
      server,
    );
    expect(chosen?.status).toBe(status);
    const stored = JSON.parse(store.debugSnapshot());
    if (action === "allow") {
      const location = new URL(chosen?.headers.get("location") ?? "");
      expect(location.protocol).toBe("cursor:");
      expect(location.searchParams.get("code")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("original-state");
      expect(stored.codes).toHaveLength(1);
      expect(stored.codes[0].orgId).toBe(count === 2 ? other : ORG_ID);
    } else {
      expect(stored).toMatchObject({ codes: [], tokens: [] });
      if (action === "cancel") {
        const location = new URL(chosen?.headers.get("location") ?? "");
        expect(location.protocol).toBe("cursor:");
        expect(location.host).toBe("callback");
        expect(location.searchParams.get("error")).toBe("access_denied");
        expect(location.searchParams.get("state")).toBe("original-state");
        expect(location.searchParams.has("code")).toBe(false);
      } else {
        expect(chosen?.headers.get("location")).toBeNull();
      }
    }
    if (action === "allow" || action === "cancel") {
      expect(chosen?.headers.getSetCookie().join(";")).toContain("Max-Age=0");
      expect(chosen?.headers.get("cache-control")).toBe("no-store");
    }
    expect(store.debugSnapshot()).not.toContain("supabase-access-token");
  });
  test("oversized OAuth JSON and form requests return OAuth 413 errors", async () => {
    const server = {
      store: createMemoryAuthStore(),
      fetch: (async () => {
        throw new Error("unexpected identity request");
      }) satisfies AuthFetch,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-test",
      authSecret: "test-secret-at-least-16",
      publicUrl: PUBLIC,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    };
    for (const path of ["/register", "/token"]) {
      const response = await handleOAuthRequest(
        new Request(`${PUBLIC}${path}`, {
          method: "POST",
          body: "x".repeat(8193),
        }),
        server,
      );
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: "invalid_request" });
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });
});
