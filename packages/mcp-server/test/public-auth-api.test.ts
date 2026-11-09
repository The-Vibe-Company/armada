import { expect, test } from "bun:test";
import { createMemoryAuthStore } from "@armada/auth";
import type { VaultStore } from "@armada/core";
import { type ControlOptions, createHandler, handleControlRequest } from "../src/index.ts";

const challenge = "a".repeat(43);
const state = "state123";
const verifier = "v".repeat(43);
const session = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  user: { id: "11111111-1111-4111-8111-111111111111" },
};
const secrets = ["anon-secret", "provider-secret", "refresh-secret"];

function publicHandler(respond: (request: Request) => Promise<Response> | Response) {
  const supabase = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return respond(request);
  };
  const options: ControlOptions = {
    publicUrl: "https://armada.test",
    authStore: createMemoryAuthStore(),
    supabase: { supabaseUrl: "https://supabase.test", anonKey: "anon-secret", fetch: supabase },
    store: {} as VaultStore,
    encryptionKey: undefined,
  };
  return createHandler({
    publicUrl: "https://armada.test",
    oauth: {} as never,
    authStore: options.authStore,
    supabase: options.supabase,
    data: (() => ({})) as never,
    vault: {} as never,
    encryptionKey: undefined,
    providerFor: (() => ({})) as never,
    routes: [(request) => handleControlRequest(request, options)],
  });
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://armada.test/api/v1/${path}`, init);
}

test("public browser authorize validates strict loopback PKCE and preserves randomized state", async () => {
  const handler = publicHandler(() => new Response("unexpected", { status: 500 }));
  const response = await handler(
    request(
      `auth/authorize?provider=github&redirect_uri=${encodeURIComponent("http://127.0.0.1:43123/callback")}&code_challenge=${challenge}&state=${state}`,
    ),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://supabase.test");
  expect(location.pathname).toBe("/auth/v1/authorize");
  expect(location.searchParams.get("provider")).toBe("github");
  expect(location.searchParams.get("redirect_to")).toBe("http://127.0.0.1:43123/callback");
  expect(location.searchParams.get("code_challenge")).toBe(challenge);
  expect(location.searchParams.get("code_challenge_method")).toBe("s256");
  expect(location.searchParams.get("state")).toBeNull();

  for (const redirect of [
    "https://example.test/callback",
    "http://127.0.0.1/callback",
    "http://user:pass@127.0.0.1:43123/callback",
  ]) {
    const refused = await handler(
      request(
        `auth/authorize?provider=github&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&state=${state}`,
      ),
    );
    expect(refused.status).toBe(400);
  }
  const badChallenge = await handler(
    request(
      `auth/authorize?provider=github&redirect_uri=${encodeURIComponent("http://localhost:43123/callback")}&code_challenge=short&state=${state}`,
    ),
  );
  expect(badChallenge.status).toBe(400);
});

test("public exchange forwards the verifier and exposes only the session DTO", async () => {
  let providerRequest: Request | undefined;
  const handler = publicHandler(async (request) => {
    providerRequest = request;
    return Response.json(session);
  });
  const response = await handler(
    request("auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "authorization-code", verifier }),
    }),
  );
  expect(response.status).toBe(200);
  expect(providerRequest?.url).toBe("https://supabase.test/auth/v1/token?grant_type=pkce");
  expect(await providerRequest?.json()).toEqual({ auth_code: "authorization-code", code_verifier: verifier });
  expect(await response.json()).toEqual({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: expect.any(String),
  });
});

test("public refresh succeeds and refusal never exposes provider configuration or secrets", async () => {
  let body: unknown;
  const handler = publicHandler(async (request) => {
    body = await request.json();
    return Response.json(session);
  });
  const success = await handler(
    request("auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-secret" }),
    }),
  );
  expect(success.status).toBe(200);
  expect(body).toEqual({ refresh_token: "refresh-secret" });
  expect(await success.json()).toEqual({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: expect.any(String),
  });

  const refusedHandler = publicHandler(() => new Response("provider-secret", { status: 401 }));
  const refused = await refusedHandler(
    request("auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-secret" }),
    }),
  );
  expect(refused.status).toBe(401);
  const text = await refused.text();
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).toContain("Refresh token was refused.");
});

test("public email start validates input and valid start and verify use the provider shapes", async () => {
  const calls: Request[] = [];
  const handler = publicHandler(async (request) => {
    calls.push(request);
    return Response.json(session);
  });
  const invalid = await handler(
    request("auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-email" }),
    }),
  );
  expect(invalid.status).toBe(400);

  const start = await handler(
    request("auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "person@example.test",
        redirect_uri: "http://localhost:43123/callback",
        code_challenge: challenge,
        state,
      }),
    }),
  );
  expect(start.status).toBe(200);
  expect(calls[0]?.url).toBe(
    "https://supabase.test/auth/v1/otp?redirect_to=https%3A%2F%2Farmada.test%2Flogin%3Fflow%3Dcode",
  );
  expect(await calls[0]?.json()).toEqual({
    email: "person@example.test",
    create_user: true,
    code_challenge: challenge,
    code_challenge_method: "s256",
  });

  const verify = await handler(
    request("auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.test", code: "123 456" }),
    }),
  );
  expect(verify.status).toBe(200);
  expect(calls[1]?.url).toBe("https://supabase.test/auth/v1/verify");
  expect(await calls[1]?.json()).toEqual({ type: "email", email: "person@example.test", token: "123456" });
});
