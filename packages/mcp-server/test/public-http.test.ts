import { afterEach, expect, test } from "bun:test";
import { VERSION } from "@armada/core";
import { createHandler, type HandlerOptions } from "../src/http.ts";

const PUBLIC_URL = "https://armada.example.test";
const forbiddenCalls: string[] = [];

function forbidden(name: string): never {
  forbiddenCalls.push(name);
  throw new Error(`Public routing must not call ${name}`);
}

function inert<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => forbidden(`${name}.${String(property)}`),
  });
}

afterEach(() => {
  const calls = forbiddenCalls.splice(0);
  expect(calls).toEqual([]);
});

/** No SQL harness, provider state, network or MCP client is needed for public routes. */
function handler(overrides: Partial<HandlerOptions> = {}) {
  const store = inert<HandlerOptions["authStore"]>("authStore");
  return createHandler({
    publicUrl: PUBLIC_URL,
    authStore: store,
    data: () => forbidden("data"),
    vault: inert<HandlerOptions["vault"]>("vault"),
    encryptionKey: undefined,
    providerFor: () => forbidden("providerFor"),
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "anon",
      fetch: () => forbidden("supabase.fetch"),
    },
    oauth: {
      store,
      fetch: () => forbidden("oauth.fetch"),
      supabaseUrl: "https://project.supabase.co",
      anonKey: "anon",
      authSecret: "unused_auth_secret",
      publicUrl: PUBLIC_URL,
      now: () => forbidden("oauth.now"),
    },
    ...overrides,
  });
}

test("health answers without authentication and disables caching", async () => {
  const response = await handler()(new Request(`${PUBLIC_URL}/healthz`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, version: VERSION });
});

test.each(["false", "rejection"] as const)(
  "health exposes readiness %s as unavailable without leaking causes",
  async (mode) => {
    const response = await handler({
      ready: async () => {
        if (mode === "rejection") throw new Error("private_database_diagnostic");
        return false;
      },
    })(new Request(`${PUBLIC_URL}/healthz`));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ ok: false, version: VERSION, reason: "database_unavailable" });
  },
);

test("CLI discovery exposes only public configuration without authentication", async () => {
  const response = await handler()(new Request(`${PUBLIC_URL}/.well-known/armada.json`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    version: 1,
    supabaseUrl: "https://project.supabase.co",
    anonKey: "anon",
    controlUrl: PUBLIC_URL,
    providers: [],
  });
});

test("OAuth discovery takes precedence over mounted routes", async () => {
  const response = await handler({ routes: [async () => forbidden("mounted route")] })(
    new Request(`${PUBLIC_URL}/.well-known/oauth-protected-resource`),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp` });
});

test("mounted routes precede MCP and null falls through to its OAuth challenge", async () => {
  const handle = handler({
    routes: [
      async (request) => (new URL(request.url).pathname === "/api/v1/org/list" ? Response.json({ orgs: [] }) : null),
    ],
  });
  const response = await handle(new Request(`${PUBLIC_URL}/api/v1/org/list`, { method: "POST" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ orgs: [] });
  const mcp = await handle(new Request(`${PUBLIC_URL}/mcp`, { method: "POST" }));
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get("www-authenticate")).toContain(
    `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  );
});
