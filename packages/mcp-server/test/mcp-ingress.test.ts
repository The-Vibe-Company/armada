import { expect, test } from "bun:test";
import { createSqlAuthStore } from "@armada/auth";
import type { Sql } from "@armada/core/server";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";

// Authority checks run before credentials, SQL or upstream transport are needed.
test("gateway ingress challenges exact TLS-proxy authority without trusting forwarded spoofing", async () => {
  let queries = 0;
  const sql: Sql = {
    async query() {
      queries++;
      throw Error("Ingress admission must not query the database");
    },
  };
  const service = createMcpHttpIntegration({
    sql,
    authStore: createSqlAuthStore(sql),
    encryptionKey: undefined,
    publicUrl: "https://gateway.example",
    supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
    deferBackground: true,
    fetch: async () => {
      throw Error("Ingress admission must not contact an upstream");
    },
  });
  const path = "/mcp/gateway/connection";
  const anonymous = async (headers: Record<string, string>) => {
    const response = await service.route(
      new Request(`http://gateway.example${path}`, { method: "POST", headers, body: "{}" }),
    );
    if (!response) throw Error("Missing gateway ingress route");
    return response;
  };
  try {
    const challenge = await anonymous({ host: "gateway.example" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain("Bearer");
    expect(
      (await anonymous({ host: "wrong.example", "x-forwarded-host": "gateway.example", "x-forwarded-proto": "https" }))
        .status,
    ).toBe(403);
    expect(
      (
        await anonymous({
          host: "gateway.example:444",
          "x-forwarded-host": "gateway.example",
          "x-forwarded-proto": "https",
        })
      ).status,
    ).toBe(403);
    expect((await anonymous({ host: "gateway.example", origin: "https://wrong.example" })).status).toBe(403);
    expect((await anonymous({ host: "gateway.example", origin: "http://gateway.example" })).status).toBe(403);
    // Forwarded values have no influence on a correctly identified authority either.
    expect(
      (await anonymous({ host: "gateway.example", "x-forwarded-host": "wrong.example", "x-forwarded-proto": "http" }))
        .status,
    ).toBe(401);
    for (const host of [
      "wrong.example",
      "gateway.example:444",
      "gateway.example@wrong.example",
      "gateway.example/path",
    ])
      expect(
        (
          await service.route(
            new Request(`http://gateway.example${path}`, {
              method: "POST",
              headers: { host, "x-forwarded-host": "gateway.example", "x-forwarded-proto": "https" },
              body: "{}",
            }),
          )
        )?.status,
      ).toBe(403);
    expect(
      (
        await service.route(
          new Request(`http://user@gateway.example${path}`, {
            method: "POST",
            headers: { host: "gateway.example" },
            body: "{}",
          }),
        )
      )?.status,
    ).toBe(403);
    expect(queries).toBe(0);
  } finally {
    await service.close();
  }
});
