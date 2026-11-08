import { expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { proxy } from "../src/proxy.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

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
  const response = await proxy(request("/sandboxes"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://dashboard.test/login?next=%2Fsandboxes");
});
