import { expect, test } from "bun:test";
import { createServiceToken, createSqlAuthStore, generateToken, sha256Hex } from "@armada/auth";
import { CONTROL_BODY_MAX_BYTES, type McpConnectionDto } from "@armada/core";
import { createSqlMcpLeasePort, createSqlVaultStore, type Sql } from "@armada/core/server";
import { endpoint } from "@armada/mcp-gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { configFromEnv } from "../src/config.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpOAuthStore, createMcpSecretBox } from "../src/mcp-integration.ts";
import { migratedDatabase } from "./migrated-database.ts";

test("HTTP connection control routes through mcp-control with standard envelopes, bounded bodies, and stdio validation", async () => {
  const db = await migratedDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const user = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'MCP HTTP')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    const authStore = createSqlAuthStore(db);
    const { token } = await createServiceToken(authStore, { userId: user, now: new Date() });
    const secondOrg = crypto.randomUUID();
    await db.query("insert into public.orgs(id,name) values($1,'Second MCP org')", [secondOrg]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [secondOrg, user]);
    const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const supabase = { supabaseUrl: "https://supabase.example", anonKey: "public-anon" };
    integration = createMcpHttpIntegration({
      sql: db,
      encryptionKey,
      dashboardUrl: "https://dashboard.example",
      publicUrl: "https://armada.example",
      deferBackground: true,
    });
    const route = integration.route;
    const controlOptions = {
      authStore,
      supabase,
      encryptionKey,
      store: createSqlVaultStore(db),
      data: createSqlData(db),
      mcp: { registry: integration.registry, broker: integration.controlBroker },
    };
    const post = async (action: string, body: unknown, bearer = token) => {
      const request = new Request(`https://armada.example/api/v1/mcp/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(await route(request)).toBeNull();
      const response = await handleControlRequest(request, controlOptions);
      if (!response) throw Error("Route missing");
      return {
        status: response.status,
        body: (await response.json()) as {
          connection: McpConnectionDto;
          connections: McpConnectionDto[];
          ok: boolean;
          error?: { code: string; message: string };
        },
      };
    };
    const sandboxId = crypto.randomUUID(),
      goldenId = crypto.randomUUID(),
      member = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [member]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, member]);
    await db.query("insert into goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'route-test','org')", [
      goldenId,
      org,
      user,
    ]);
    await db.query(
      "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,'bx_route','claude','ready')",
      [sandboxId, goldenId, org, user],
    );
    expect(
      await integration.route(
        new Request("https://armada.example/api/internal/github/credentials", {
          method: "POST",
          body: "{}",
        }),
      ),
    ).toBeNull();
    const oversized = await handleControlRequest(
      new Request("https://armada.example/api/v1/mcp/create", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ org, padding: "x".repeat(CONTROL_BODY_MAX_BYTES + 1) }),
      }),
      controlOptions,
    );
    expect(oversized?.status).toBe(413);
    expect(await oversized?.json()).toEqual({ error: { code: "invalid", message: expect.any(String) } });
    const unpinned = await post("create", {
      org,
      name: "Unpinned",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["server@latest"],
    });
    expect(unpinned.status).toBe(400);
    expect(unpinned.body.error).toEqual({ code: "invalid", message: expect.stringContaining("stdio requires") });
    const memberToken = (await createServiceToken(authStore, { userId: member, now: new Date() })).token;
    const deniedSandbox = await post("sandbox-connections", { org, id: sandboxId }, memberToken);
    expect(deniedSandbox.status).toBe(404);
    expect(deniedSandbox.body.error).toEqual({ code: "not_found", message: "No such sandbox." });
    expect((await post("sandbox-connections", { org, id: sandboxId })).status).toBe(200);
    await db.query("update members set role='admin' where org_id=$1 and user_id=$2", [org, member]);
    expect((await post("sandbox-connections", { org, id: sandboxId }, memberToken)).status).toBe(200);
    await db.query("update members set role='member' where org_id=$1 and user_id=$2", [org, member]);
    expect((await post("sandbox-connections", { org, id: sandboxId }, memberToken)).status).toBe(404);
    const catalog = await post("catalog", { org });
    expect(catalog.status).toBe(200);
    expect(
      (catalog.body as unknown as { services: { id: string; availability: string }[] }).services.find(
        (s) => s.id === "slack",
      )?.availability,
    ).toBe("setup_required");
    const preset = await post("create", {
      org,
      serviceId: "linear",
      name: "Work",
      scope: "personal",
      url: "https://untrusted.example",
    });
    expect(preset.body.connection.url).toBe("https://mcp.linear.app/mcp");
    const beforeMetadata = (
      await db.query("select * from mcp_grants where connection_id=$1", [preset.body.connection.id])
    ).rows;
    const renamed = await post("metadata", {
      org,
      id: preset.body.connection.id,
      name: "Work renamed",
      defaultForLaunch: true,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection).toMatchObject({
      id: preset.body.connection.id,
      name: "Work renamed",
      defaultForLaunch: true,
      catalogId: "linear",
    });
    expect(
      (await db.query("select * from mcp_grants where connection_id=$1", [preset.body.connection.id])).rows,
    ).toEqual(beforeMetadata);
    expect((await post("metadata", { org: secondOrg, id: preset.body.connection.id, name: "Wrong org" })).status).toBe(
      403,
    );
    expect((await post("delete", { org, id: preset.body.connection.id })).status).toBe(200);
    const secret = crypto.randomUUID();
    const created = await post("create", {
      org: org,
      name: "Private endpoint",
      scope: "personal",
      transport: "http",
      url: "https://example.com/mcp?region=eu",
      authType: "bearer",
      authentication: secret,
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(created.body.connection.status).toBe("not_connected");
    const list = await post("list", { org: org });
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0]?.url).toBe("https://example.com/mcp?region=eu");
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const wrongOrgList = await post("list", { org: secondOrg });
    expect(wrongOrgList.status).toBe(403);
    expect(wrongOrgList.body.error).toEqual({ code: "forbidden", message: expect.any(String) });
    const mcp = generateToken("access");
    await authStore.insertToken("mcp", {
      userId: user,
      orgId: org,
      hash: await sha256Hex(mcp),
      label: "access",
      createdAt: new Date().toISOString(),
    });
    const oauthStore = createMcpOAuthStore(db, encryptionKey),
      box = createMcpSecretBox(encryptionKey);
    const state = crypto.randomUUID(),
      stateHash = await sha256Hex(state);
    await oauthStore.putPending(stateHash, {
      actorId: user,
      connectionId: created.body.connection.id,
      expiresAt: Date.now() + 60000,
      sealed: await box.seal(JSON.stringify({ generation: await oauthStore.generation(created.body.connection.id) })),
    });
    for (const bearer of [token, mcp]) {
      const refusal = await post("oauth/callback", { org: secondOrg, state, code: crypto.randomUUID() }, bearer);
      expect(refusal.status).toBe(403);
      expect(refusal.body.error).toEqual({ code: "forbidden", message: expect.any(String) });
    }
    expect(await oauthStore.takePending(stateHash, user, Date.now())).not.toBeNull();
    expect(await route(new Request("https://armada.example/api/control/mcp/list", { method: "POST" }))).toBeNull();
    const metadata = await route(new Request("https://armada.example/.well-known/armada-mcp-client.json"));
    if (!metadata) throw Error("Metadata missing");
    expect((await metadata.json()) as { client_id: string; redirect_uris: string[] }).toMatchObject({
      client_id: "https://dashboard.example/.well-known/armada-mcp-client.json",
      redirect_uris: ["https://dashboard.example/auth/mcp/callback"],
    });
    expect(
      (
        await route(
          new Request(`https://armada.example/mcp/gateway/${created.body.connection.id}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      )?.status,
    ).toBe(403);
    expect((await post("update", { org, id: created.body.connection.id, name: "partial update" })).status).toBe(400);
    const replacement = {
      org,
      id: created.body.connection.id,
      name: "Replaced definition",
      scope: "personal",
      transport: "http",
      url: "https://example.com/mcp?region=eu",
      authType: "bearer",
    };
    expect((await post("update", { ...replacement, scope: "org" })).status).toBe(400);
    expect((await post("update", replacement)).body.connection.status).toBe("not_connected");
    expect(
      (
        await db.query<{ value_enc: Uint8Array | null }>(
          "select value_enc from public.mcp_grants where connection_id=$1",
          [created.body.connection.id],
        )
      ).rows[0]?.value_enc,
    ).toBeNull();
    expect(
      (await post("set-enabled", { org: org, id: created.body.connection.id, enabled: false })).body.connection.status,
    ).toBe("disabled");
    const revoked = await post("revoke", { org: org, id: created.body.connection.id });
    expect(revoked.body.ok).toBe(true);
  } finally {
    await integration?.close();
    await db.close();
  }
});

test("auto-discovery forwards discovered resourceMetadataUrl and scope into OAuth broker.connect", async () => {
  const db = await migratedDatabase();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const user = crypto.randomUUID(),
      org = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Auto discovery')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    const customMetadataUrl = "https://remote.example/custom-prm.json";
    const fetchedUrls: string[] = [];
    integration = createMcpHttpIntegration({
      sql: db,
      encryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      publicUrl: "https://armada.example",
      dashboardUrl: "https://dashboard.example",
      deferBackground: true,
      fetch: (async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        fetchedUrls.push(`${request.method} ${request.url}`);
        if (request.url === "https://remote.example/mcp") {
          return request.method === "POST"
            ? new Response(null, {
                status: 401,
                headers: { "www-authenticate": `Bearer resource_metadata="${customMetadataUrl}", scope="custom:read"` },
              })
            : new Response(null, { status: 401 });
        }
        if (request.url === customMetadataUrl)
          return Response.json({
            resource: "https://remote.example/mcp",
            authorization_servers: ["https://issuer.example"],
          });
        if (request.url === "https://issuer.example/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: "https://issuer.example",
            authorization_endpoint: "https://issuer.example/authorize",
            token_endpoint: "https://issuer.example/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
          });
        throw Error(`Unexpected fetch: ${request.method} ${request.url}`);
      }) as typeof fetch,
    });
    const connection = await integration.registry.save(user, org, {
      name: "Auto remote",
      scope: "personal",
      transport: "http",
      url: "https://remote.example/mcp",
    });
    const result = await integration.controlBroker.connect({ userId: user, orgId: org, connectionId: connection.id });
    expect(new URL(result.authorizationUrl!).searchParams.get("scope")).toBe("custom:read");
    expect(fetchedUrls.filter((entry) => entry === `GET ${customMetadataUrl}`)).toHaveLength(2);
  } finally {
    await integration?.close();
    await db.close();
  }
});

test("invalidation poller skips idle DB queries, seeds on first lease, and backs off without closing active sessions", async () => {
  const db = await migratedDatabase();
  const servers: McpServer[] = [];
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  let tickCallback: (() => void) | undefined;
  try {
    const user = crypto.randomUUID(),
      org = crypto.randomUUID(),
      goldenId = crypto.randomUUID(),
      sandboxId = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Poller test')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    await db.query("insert into goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'poller','org')", [
      goldenId,
      org,
      user,
    ]);
    await db.query(
      "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,'bx_poll','claude','ready')",
      [sandboxId, goldenId, org, user],
    );
    let invalidationReads = 0,
      failInvalidations = false,
      currentTime = Date.now(),
      toolCalls = 0;
    const logs: string[] = [];
    let onLog: (() => void) | undefined;
    let failInFlight: ReturnType<typeof Promise.withResolvers<never>> | undefined;
    const trackedSql: Sql = {
      async query<T>(statement: string, params?: unknown[]) {
        if (statement.includes("from public.mcp_invalidations e")) {
          invalidationReads++;
          if (failInFlight) return failInFlight.promise;
          if (failInvalidations) throw new Error("transient_db_outage");
        }
        return db.query<T>(statement, params);
      },
    };
    const upstream: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      let transport = transports.get(request.headers.get("mcp-session-id") ?? "");
      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          keepAliveMs: 0,
        });
        const remote = new McpServer({ name: "Poller remote", version: "1" });
        remote.registerTool("ping_tool", {}, async () => ({ content: [{ type: "text", text: `ok ${++toolCalls}` }] }));
        await remote.connect(transport);
        servers.push(remote);
      }
      const response = await transport.handleRequest(request);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return response;
    };
    integration = createMcpHttpIntegration({
      sql: trackedSql,
      encryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      publicUrl: "https://armada.example",
      dashboardUrl: "https://dashboard.example",
      deferBackground: true,
      fetch: upstream,
      now: () => currentTime,
      logError: (line) => {
        logs.push(line);
        onLog?.();
      },
      schedule: {
        setInterval: (fn) => {
          tickCallback = fn;
          return { unref() {} } as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => {
          tickCallback = undefined;
        },
      },
    });
    integration.startBackground();
    tickCallback!();
    await integration.drainInvalidations();
    expect(invalidationReads).toBe(0);

    const connection = await integration.registry.save(user, org, {
      name: "Live remote",
      scope: "personal",
      transport: "http",
      url: "https://remote.example/mcp",
      authType: "none",
    });
    await db.query("update public.mcp_grants set status='connected' where connection_id=$1", [connection.id]);
    await integration.connections.bind(sandboxId, [connection.id]);
    const token = `armada_gw_${crypto.randomUUID()}`;
    await createSqlMcpLeasePort(db).issue({
      sandboxId,
      connectionId: connection.id,
      tokenHash: await sha256Hex(token),
      operations: ["tools"],
      expiresAt: new Date(currentTime + 3_600_000),
    });
    const client = new Client({ name: "Poller client", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`https://armada.example/mcp/gateway/${connection.id}`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: async (input, init) =>
            (await integration!.route(new Request(String(input), init))) ?? new Response(null, { status: 404 }),
        }),
      );
      expect(await client.callTool({ name: "ping_tool", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "ok 1" }],
      });
      const waitLog = () => {
        const next = Promise.withResolvers<void>();
        onLog = () => {
          onLog = undefined;
          next.resolve();
        };
        return next.promise;
      };
      failInvalidations = true;
      const firstLog = waitLog();
      tickCallback!();
      await firstLog;
      expect(invalidationReads).toBe(1);
      expect(logs).toEqual(["armada: MCP invalidation poller unavailable; backing off."]);
      currentTime += 100;
      tickCallback!();
      expect(invalidationReads).toBe(1);
      expect(await client.callTool({ name: "ping_tool", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "ok 2" }],
      });
      currentTime += 250;
      failInvalidations = false;
      failInFlight = Promise.withResolvers<never>();
      const secondLog = waitLog();
      tickCallback!();
      tickCallback!();
      tickCallback!();
      tickCallback!();
      const pendingFailure = failInFlight;
      failInFlight = undefined;
      pendingFailure.reject(new Error("slow_db_timeout"));
      await secondLog;
      expect(invalidationReads).toBe(2);
      expect(logs.length).toBe(2);
      currentTime += 499;
      tickCallback!();
      expect(invalidationReads).toBe(2);
      currentTime += 1;
      await integration.registry.revoke(user, org, connection.id);
      tickCallback!();
      await integration.drainInvalidations();
      expect(invalidationReads).toBe(4);
      await expect(client.callTool({ name: "ping_tool", arguments: {} })).rejects.toThrow();
      const readsAfterEviction = invalidationReads;
      tickCallback!();
      expect(invalidationReads).toBe(readsAfterEviction);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await integration?.close();
    await Promise.all(servers.map((server) => server.close()));
    await db.close();
  }
});

test("concurrent authenticate and lease eviction never resets invalidation cursor for surviving leases", async () => {
  const db = await migratedDatabase();
  const servers: McpServer[] = [];
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const user = crypto.randomUUID(),
      org = crypto.randomUUID(),
      goldenId = crypto.randomUUID(),
      sandboxId = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Race test')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    await db.query("insert into goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'race','org')", [
      goldenId,
      org,
      user,
    ]);
    await db.query(
      "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status) values($1,$2,$3,$4,'bx_race','claude','ready')",
      [sandboxId, goldenId, org, user],
    );
    const tokenA = `armada_gw_${crypto.randomUUID()}`,
      tokenB = `armada_gw_${crypto.randomUUID()}`,
      tokenC = `armada_gw_${crypto.randomUUID()}`;
    const hashA = await sha256Hex(tokenA),
      hashB = await sha256Hex(tokenB),
      hashC = await sha256Hex(tokenC);
    let seedCalls = 0,
      bValidateCount = 0,
      bLeaseId = "";
    const bReadyToSeed = Promise.withResolvers<void>();
    const bPaused = Promise.withResolvers<void>();
    const resumeB = Promise.withResolvers<void>();
    const racedSql: Sql = {
      async query<T>(statement: string, params?: unknown[]) {
        if (
          statement.includes("select $1::uuid,id from public.mcp_invalidations") &&
          !statement.includes("where id=any")
        ) {
          seedCalls++;
          await bReadyToSeed.promise;
        }
        if (statement.includes("from public.mcp_leases") && params?.[0] === hashB) {
          bValidateCount++;
          if (bValidateCount === 2) {
            bPaused.resolve();
            await resumeB.promise;
          }
        }
        const result = await db.query<T>(statement, params);
        if (statement.includes("select expires_at from public.mcp_leases") && params?.[0] === bLeaseId) {
          bReadyToSeed.resolve();
        }
        return result;
      },
    };
    const upstream: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      let transport = transports.get(request.headers.get("mcp-session-id") ?? "");
      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          keepAliveMs: 0,
        });
        const remote = new McpServer({ name: "Race remote", version: "1" });
        remote.registerTool("ping_tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
        await remote.connect(transport);
        servers.push(remote);
      }
      const response = await transport.handleRequest(request);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return response;
    };
    integration = createMcpHttpIntegration({
      sql: racedSql,
      encryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      publicUrl: "https://armada.example",
      dashboardUrl: "https://dashboard.example",
      deferBackground: true,
      fetch: upstream,
    });
    const makeConnection = async (name: string, hash: string) => {
      const conn = await integration!.registry.save(user, org, {
        name,
        scope: "personal",
        transport: "http",
        url: `https://${name.toLowerCase()}.example/mcp`,
        authType: "none",
      });
      await db.query("update public.mcp_grants set status='connected' where connection_id=$1", [conn.id]);
      await integration!.connections.bind(sandboxId, [conn.id]);
      await createSqlMcpLeasePort(db).issue({
        sandboxId,
        connectionId: conn.id,
        tokenHash: hash,
        operations: ["tools"],
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return conn;
    };
    const connA = await makeConnection("ConnA", hashA);
    const connB = await makeConnection("ConnB", hashB);
    bLeaseId = (await db.query<{ id: string }>("select id from public.mcp_leases where hash=$1", [hashB])).rows[0]!.id;
    const connC = await makeConnection("ConnC", hashC);
    const connectClient = (connectionId: string, token: string) => {
      const client = new Client({ name: `Client ${connectionId}`, version: "1" });
      const connected = client.connect(
        new StreamableHTTPClientTransport(new URL(`https://armada.example/mcp/gateway/${connectionId}`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: async (input, init) =>
            (await integration!.route(new Request(String(input), init))) ?? new Response(null, { status: 404 }),
        }),
      );
      return { client, connected };
    };
    const a = connectClient(connA.id, tokenA);
    const b = connectClient(connB.id, tokenB);
    let c: ReturnType<typeof connectClient> | undefined;
    try {
      await Promise.all([a.connected, bPaused.promise]);
      await integration.registry.revoke(user, org, connA.id);
      await integration.drainInvalidations();
      resumeB.resolve();
      await b.connected;
      await integration.registry.revoke(user, org, connB.id);
      c = connectClient(connC.id, tokenC);
      await c.connected;
      expect(seedCalls).toBe(1);
      await integration.drainInvalidations();
      await expect(b.client.callTool({ name: "ping_tool", arguments: {} })).rejects.toThrow();
      expect(await c.client.callTool({ name: "ping_tool", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "ok" }],
      });
    } finally {
      resumeB.resolve();
      await Promise.allSettled([a.client.close(), b.client.close(), c?.client.close()]);
    }
  } finally {
    await integration?.close();
    await Promise.all(servers.map((server) => server.close()));
    await db.close();
  }
});

test("actual MCP integration construction preserves explicitly configured development dashboard callback origin", async () => {
  const sql: Sql = {
    async query() {
      throw Error("Static client metadata does not need a database.");
    },
  };
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  try {
    const config = configFromEnv({
      NODE_ENV: "development",
      ARMADA_MODAL_DIALOUT: "1",
      ARMADA_MODAL_RUNTIME_MANIFEST: "/opt/runtime.json",
      ARMADA_DATABASE_URL: "postgres://fixture",
      SUPABASE_URL: "https://auth.example",
      SUPABASE_ANON_KEY: "public",
      ARMADA_AUTH_SECRET: "fixture-auth-secret-long-enough",
      ARMADA_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      ARMADA_PUBLIC_URL: "https://gateway.example",
      ARMADA_DASHBOARD_URL: "http://localhost:3000",
    });
    const options = {
      sql,
      encryptionKey: config.encryptionKey,
      publicUrl: config.publicUrl,
      dashboardUrl: config.dashboardUrl,
    };
    expect(() => createMcpHttpIntegration(options)).toThrow("ARMADA_DASHBOARD_URL");
    integration = createMcpHttpIntegration({ ...options, development: config.development });
    const response = await integration.route(new Request("https://gateway.example/.well-known/armada-mcp-client.json"));
    expect(response?.status).toBe(200);
    if (!response) throw Error("Missing client metadata route");
    expect((await response.json()) as { client_id: string; redirect_uris: string[] }).toMatchObject({
      client_id: "http://localhost:3000/.well-known/armada-mcp-client.json",
      redirect_uris: ["http://localhost:3000/auth/mcp/callback"],
    });
    expect(() => endpoint("http://localhost:3000/upstream")).toThrow();
  } finally {
    await integration?.close();
  }
});
