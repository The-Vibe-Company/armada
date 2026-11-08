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

function request(pathname: string): NextRequest {
  const nextUrl = new URL(`https://dashboard.test${pathname}`);
  Object.assign(nextUrl, { clone: () => new URL(nextUrl) });
  return { nextUrl, cookies: { getAll: () => [] } } as unknown as NextRequest;
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
