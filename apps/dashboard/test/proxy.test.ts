import { afterEach, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { proxy } from "../src/proxy.ts";

const environment = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

function setSupabaseEnvironment() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
}

afterEach(() => {
  if (environment.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = environment.url;
  if (environment.anonKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = environment.anonKey;
});

function request(pathname: string, method = "GET", cookies: { name: string; value: string }[] = []): NextRequest {
  const nextUrl = new URL(`https://dashboard.test${pathname}`);
  Object.assign(nextUrl, { clone: () => new URL(nextUrl) });
  return {
    method,
    nextUrl,
    headers: new Headers(),
    cookies: { getAll: () => cookies, set: () => undefined },
  } as unknown as NextRequest;
}

test("API v1 bypasses the dashboard cookie guard", async () => {
  const response = await proxy(request("/api/v1/auth/email/start"));
  expect(response.headers.get("x-middleware-next")).toBe("1");
});

test("the dashboard guard still protects non-API pages", async () => {
  setSupabaseEnvironment();
  const response = await proxy(request("/sandboxes"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://dashboard.test/login?next=%2Fsandboxes");
});

test("the landing needs no session: the landing and a signed-out / pass before any Supabase setting is read", async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  for (const path of ["/landing", "/landing/opengraph-image"]) {
    const response = await proxy(request(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  }
  // No session cookie (a PKCE verifier is not a session): the landing, with no Supabase settings at all.
  for (const cookies of [[], [{ name: "sb-project-auth-token-code-verifier", value: "v" }]]) {
    const front = await proxy(request("/?msclkid=1&UTM_SOURCE=launch&ref=x", "GET", cookies));
    expect(front.headers.get("x-middleware-rewrite")).toBe("https://dashboard.test/landing");
    expect(front.headers.get("vary")).toBe("Cookie");
  }
  // A session cookie means a session lookup, which needs the settings.
  await expect(proxy(request("/", "GET", [{ name: "sb-project-auth-token.0", value: "x" }]))).rejects.toThrow();
});

test("a stale session cookie on / is still the landing; a write to / still goes to the login page", async () => {
  setSupabaseEnvironment();
  const stale = await proxy(request("/?next=x", "GET", [{ name: "sb-project-auth-token", value: "not-a-session" }]));
  expect(stale.headers.get("x-middleware-rewrite")).toBe("https://dashboard.test/landing");
  const write = await proxy(request("/", "POST"));
  expect(write.headers.get("x-middleware-rewrite")).toBeNull();
  expect(write.status).toBe(307);
});

test("only exact GET/HEAD stats reads bypass the session gate", async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  for (const method of ["GET", "HEAD"]) {
    const response = await proxy(request("/api/stats?daily=1", method));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  }
  setSupabaseEnvironment();
  for (const [path, method] of [
    ["/api/stats", "POST"],
    ["/api/stats/extra", "GET"],
    ["/api/sandboxes", "GET"],
  ]) {
    const response = await proxy(request(path, method));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in again." });
  }
});
