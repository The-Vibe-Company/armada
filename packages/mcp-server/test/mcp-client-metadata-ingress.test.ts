import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore } from "@armada/auth";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { migratedDatabase } from "./migrated-database.ts";

test("TLS-terminated anonymous CIMD preserves the advertised OAuth client and fixed callback without trusting caller authority", async () => {
  const db = await migratedDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const user = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into orgs(id,name) values($1,'CIMD ingress')", [org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    const authStore = createSqlAuthStore(db);
    const { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    const host = "armada-mcp-production.up.railway.app";
    const clientId = `https://${host}/.well-known/armada-mcp-client.json`;
    const callback = "https://dashboard.example/auth/mcp/callback";
    const network: string[] = [];
    integration = createMcpHttpIntegration({
      sql: db,
      authStore,
      encryptionKey: Buffer.alloc(32, 22).toString("base64"),
      publicUrl: `https://${host}`,
      dashboardUrl: "https://dashboard.example",
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
      fetch: (async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        network.push(init?.method ?? "GET");
        if (init?.method && init.method !== "GET")
          throw Error("No registration, token exchange or consent in this fixture");
        if (url === "https://linear.example/mcp") return new Response(null, { status: 401 });
        if (url.includes("oauth-protected-resource"))
          return Response.json({
            resource: "https://linear.example/mcp",
            authorization_servers: ["https://linear.example"],
            scopes_supported: ["read"],
          });
        if (url === "https://linear.example/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: "https://linear.example",
            authorization_endpoint: "https://linear.example/authorize",
            token_endpoint: "https://linear.example/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
          });
        throw Error("Unexpected outbound request");
      }) as typeof fetch,
    });
    const route = integration.route;
    const internal = clientId.replace("https:", "http:");
    const response = await route(new Request(internal, { headers: { host } }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/json");
    const document = (await response!.json()) as {
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(document).toMatchObject({
      client_id: clientId,
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect((await route(new Request(clientId)))?.status).toBe(200);
    // Forwarding headers never choose the client origin or callback, even on a valid ingress.
    const spoofed = await route(
      new Request(internal, {
        headers: {
          host,
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
          forwarded: "host=attacker.example;proto=http",
        },
      }),
    );
    expect(spoofed?.status).toBe(200);
    expect(await spoofed!.json()).toEqual(document);
    for (const request of [
      new Request(internal),
      new Request(internal, {
        headers: { host: "attacker.example", "x-forwarded-host": host, "x-forwarded-proto": "https" },
      }),
      new Request(internal, { headers: { host: `${host}:8080` } }),
      new Request(internal.replace(host, "attacker.example"), {
        headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "https" },
      }),
      new Request(clientId.replace(host, "attacker.example"), { headers: { host } }),
      new Request(clientId, { headers: { host: "attacker.example" } }),
      new Request(`${internal}?redirect_uri=https://attacker.example`, { headers: { host } }),
      new Request(`${internal}#fragment`, { headers: { host } }),
      ...["POST", "HEAD", "PUT"].map((method) => new Request(internal, { method, headers: { host } })),
    ])
      expect((await route(request))?.status).toBe(404);
    const connection = await integration.registry.save(user, org, {
      name: "Linear OAuth",
      scope: "personal",
      transport: "http",
      url: "https://linear.example/mcp",
      authType: "oauth",
    });
    const connect = await route(
      new Request(`https://${host}/api/v1/mcp/connect`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ org, id: connection.id }),
      }),
    );
    expect(connect?.status).toBe(200);
    const result = (await connect!.json()) as { authorizationUrl: string };
    const authorize = new URL(result.authorizationUrl);
    expect(authorize.searchParams.get("client_id")).toBe(document.client_id);
    expect(authorize.searchParams.get("redirect_uri")).toBe(document.redirect_uris[0]!);
    expect(network.every((method) => method === "GET")).toBe(true);
    expect((await db.query("select status from mcp_grants where connection_id=$1", [connection.id])).rows).toEqual([
      { status: "not_connected" },
    ]);
  } finally {
    await integration?.close();
    await db.close();
  }
});
