import { expect, test } from "bun:test";
import { GET } from "../src/app/.well-known/armada.json/route.ts";

test("discovery exposes only public login settings and the configured control API", async () => {
  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "ARMADA_MCP_URL",
    "NEXT_PUBLIC_AUTH_PROVIDERS",
    "ARMADA_ENCRYPTION_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public";
    process.env.ARMADA_MCP_URL = "https://server.example/mcp";
    process.env.NEXT_PUBLIC_AUTH_PROVIDERS = "github";
    process.env.ARMADA_ENCRYPTION_KEY = "server-only";
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public",
      controlUrl: "https://server.example",
      providers: ["github"],
    });
    delete process.env.ARMADA_MCP_URL;
    expect(GET().status).toBe(503);
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
