import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore, sha256Hex } from "@armada/auth";
import { createSqlMcpLaunchPort, createSqlMcpLeasePort, createSqlSandboxStore } from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";

test("production gateway mount canonicalizes exact configured TLS-proxy authority over real HTTP, not forwarded spoofing", async () => {
  const db = await openDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  let ingress: ReturnType<typeof Bun.serve> | undefined;
  let client: Client | undefined;
  const servers: McpServer[] = [],
    sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let toolCalls = 0,
    backendHttp = false,
    preservedQuery = false;
  const upstream: FetchLike = async (input, init) => {
    const request = new Request(String(input), init);
    expect(request.url).toBe("https://upstream.example/mcp?read_only=true");
    expect(request.headers.has("authorization")).toBe(false);
    const id = request.headers.get("mcp-session-id");
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        keepAliveMs: 0,
      });
      const server = new McpServer({ name: "Real SDK ingress fixture", version: "1" });
      server.registerTool("read_only_probe", {}, async () => {
        toolCalls++;
        return { content: [{ type: "text", text: "upstream reached" }] };
      });
      await server.connect(transport);
      servers.push(server);
    }
    const response = await transport.handleRequest(request);
    if (transport.sessionId) sessions.set(transport.sessionId, transport);
    return response;
  };
  try {
    await applyMigrations(db);
    const user = crypto.randomUUID(),
      org = crypto.randomUUID(),
      golden = crypto.randomUUID(),
      sandbox = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Ingress fixture')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    await db.query(
      "insert into public.goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'ingress','private')",
      [golden, org, user],
    );
    await createSqlSandboxStore(db).insert({
      id: sandbox,
      provider: "boat",
      providerSandboxId: "bx_ingress",
      goldenId: golden,
      orgId: org,
      ownerId: user,
      visibility: "private",
      harness: "codex",
      status: "ready",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    const authStore = createSqlAuthStore(db),
      { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    integration = createMcpHttpIntegration({
      sql: db,
      authStore,
      encryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      publicUrl: "https://gateway.example",
      fetch: upstream,
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
    });
    const service = integration;
    const control = async (action: string, body: object) => {
      const response = await service.route(
        new Request(`https://gateway.example/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ org, ...body }),
        }),
      );
      if (!response) throw Error("Control route missing");
      expect(response.status).toBe(200);
      return (await response.json()) as { connection: { id: string; status: string } };
    };
    const { connection } = await control("create", {
      name: "Read-only service",
      scope: "personal",
      transport: "http",
      authType: "none",
      url: "https://upstream.example/mcp?read_only=true",
    });
    expect((await control("connect", { id: connection.id })).connection.status).toBe("connected");
    const binding = createSqlMcpLaunchPort(db, service.registry);
    await binding.validate({ userId: user, orgId: org }, [connection.id], "private");
    await binding.bind(sandbox, [connection.id]);
    const gatewayToken = crypto.randomUUID();
    await createSqlMcpLeasePort(db).issue({
      sandboxId: sandbox,
      connectionId: connection.id,
      tokenHash: await sha256Hex(gatewayToken),
      operations: ["tools", "resources", "prompts"],
      expiresAt: new Date(Date.now() + 60000),
    });
    const path = `/mcp/gateway/${connection.id}`,
      query = "?probe=proxy%2Fcheck&probe=again";
    ingress = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        backendHttp ||= url.protocol === "http:" && url.host === "gateway.example";
        if (url.search === query) preservedQuery = true;
        return (await service.route(request)) ?? new Response(null, { status: 404 });
      },
    });
    const port = ingress.port;
    const anonymous = async (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: "{}" });
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
    const proxyFetch: FetchLike = (input, init) => {
      const target = new URL(String(input)),
        headers = new Headers(init?.headers);
      headers.set("host", target.host);
      return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { ...init, headers });
    };
    client = new Client({ name: "Real TLS-proxy SDK client", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`https://gateway.example${path}${query}`), {
        fetch: proxyFetch,
        requestInit: { headers: { authorization: `Bearer ${gatewayToken}`, origin: "https://gateway.example" } },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 0,
          maxReconnectionDelay: 0,
          reconnectionDelayGrowFactor: 1,
        },
      }),
    );
    expect((await client.callTool({ name: "read_only_probe" })).content).toEqual([
      { type: "text", text: "upstream reached" },
    ]);
    expect(toolCalls).toBe(1);
    expect(backendHttp).toBe(true);
    expect(preservedQuery).toBe(true);
  } finally {
    await client?.close();
    await integration?.close();
    ingress?.stop(true);
    await Promise.all(servers.map((server) => server.close()));
    await db.close();
  }
});
