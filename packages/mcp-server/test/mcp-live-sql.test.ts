import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceToken, createSqlAuthStore, sha256Hex } from "@armada/auth";
import type { Provider } from "@armada/core/server";
import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlSandboxStore,
  createSqlVaultStore,
} from "@armada/core/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { nativeMcpInstallScript } from "../src/mcp-native.ts";

// Distinct integration risk: real SQL grants/leases, real control discovery/capability counts,
// and SDK protocol delivery must agree, including generation rotation and registry disable.
test("SQL gateway delivers MCP objects and native configuration survives concurrent starts/restart, rotating only on physical restore", async () => {
  const db = await openDatabase();
  const home = await mkdtemp(join(tmpdir(), "armada-native-lifecycle-"));
  const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const servers: McpServer[] = [],
    clients: Client[] = [];
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let integration: ReturnType<typeof createMcpHttpIntegration> | undefined;
  let replica2: ReturnType<typeof createMcpHttpIntegration> | undefined;
  const readers = new Map<string, { read(): Promise<{ done: boolean; value?: unknown }>; cancel(): Promise<void> }>();
  let calls = 0;
  let upstreamCredential: string | undefined;
  let upstreamUnavailable = false;
  let nativeProvider: Provider | undefined;
  const upstreamFetch: FetchLike = async (input, init) => {
    const request = new Request(String(input), init);
    if (upstreamUnavailable) return new Response(null, { status: 503 });
    expect(request.url).toBe("https://upstream.example/mcp?project_ref=demo&read_only=true");
    expect(request.headers.get("authorization") === (upstreamCredential ? `Bearer ${upstreamCredential}` : null)).toBe(
      true,
    );
    const session = request.headers.get("mcp-session-id");
    let transport = session ? transports.get(session) : undefined;
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        keepAliveMs: 0,
      });
      const server = new McpServer({ name: "Independent MCP service", version: "1" });
      server.registerTool("counter", {}, async () => ({ content: [{ type: "text", text: String(++calls) }] }));
      server.registerResource("document", "example://document", {}, async (uri) => ({
        contents: [{ uri: uri.href, text: "actual document" }],
      }));
      server.registerPrompt("review", {}, async () => ({
        messages: [{ role: "user", content: { type: "text", text: "actual prompt" } }],
      }));
      await server.connect(transport);
      servers.push(server);
    }
    const response = await transport.handleRequest(request);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
    return response;
  };
  try {
    await applyMigrations(db);
    const org = crypto.randomUUID(),
      user = crypto.randomUUID(),
      golden = crypto.randomUUID(),
      sandbox = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Live MCP')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    await db.query(
      "insert into public.goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id) values($1,$2,$3,'golden','private','modal','workspace','main','ap-mcp-test')",
      [golden, org, user],
    );
    const record = await createSqlSandboxStore(db).insert({
      id: sandbox,
      provider: "modal",
      providerSandboxId: "bx_live_mcp",
      goldenId: golden,
      orgId: org,
      ownerId: user,
      harness: "codex",
      status: "ready",
      visibility: "private",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    const authStore = createSqlAuthStore(db);
    const { token: armadaToken } = await createServiceToken(authStore, { userId: user, now: new Date() });
    integration = createMcpHttpIntegration({
      sql: db,
      authStore,
      encryptionKey,
      publicUrl: "https://gateway.example",
      providerForSandbox: async (id) => {
        expect(id).toBe(sandbox);
        if (!nativeProvider) throw Error("Native provider not ready");
        return nativeProvider;
      },
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
      fetch: upstreamFetch,
    });
    const service = integration;
    const post = async (action: string, body: object) => {
      const response = await service.route(
        new Request(`https://gateway.example/api/v1/mcp/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${armadaToken}` },
          body: JSON.stringify({ org, ...body }),
        }),
      );
      if (!response) throw Error("No route");
      expect(response.status).toBe(200);
      return (await response.json()) as {
        connection: { id: string; status: string; toolCount: number; resourceCount: number; promptCount: number };
      };
    };
    const created = await post("create", {
      name: "Service",
      scope: "personal",
      transport: "http",
      url: "https://upstream.example/mcp?project_ref=demo&read_only=true",
    });
    const id = created.connection.id;
    expect((await post("connect", { id })).connection).toMatchObject({
      status: "connected",
      toolCount: 1,
      resourceCount: 1,
      promptCount: 1,
    });
    const launch = createSqlMcpLaunchPort(db, service.registry);
    await launch.validate({ userId: user, orgId: org }, [id], "private");
    await db.query("update sandboxes set visibility='org' where id=$1", [sandbox]);
    await launch.bind(sandbox, [id]);
    const leases = createSqlMcpLeasePort(db);
    const issue = async () => {
      const token = crypto.randomUUID();
      await leases.issue({
        sandboxId: sandbox,
        connectionId: id,
        tokenHash: await sha256Hex(token),
        operations: ["tools", "resources", "prompts"],
        expiresAt: new Date(Date.now() + 60000),
      });
      return token;
    };
    const connect = async (token: string, target = service) => {
      const client = new Client({ name: "native-client", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`https://gateway.example/mcp/gateway/${id}`), {
          fetch: async (input, init) => {
            const request = new Request(String(input), init);
            const response = await target.route(request);
            if (!response) throw Error("Gateway unmounted");
            if (
              request.method === "GET" &&
              response.body &&
              response.headers.get("content-type")?.includes("text/event-stream")
            ) {
              const [body, observe] = response.body.tee();
              readers.set(token, observe.getReader());
              return new Response(body, { status: response.status, headers: response.headers });
            }
            return response;
          },
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 0,
            maxReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        }),
      );
      return client;
    };
    const eof = async (token: string) => {
      const reader = readers.get(token);
      if (!reader) throw Error("Gateway notification stream was not opened");
      while (!(await reader.read()).done) {
        /* drain until transport closure */
      }
    };
    const oldToken = await issue();
    const old = await connect(oldToken);
    expect((await old.callTool({ name: "counter" })).content).toEqual([{ type: "text", text: "1" }]);
    expect((await old.readResource({ uri: "example://document" })).contents[0]).toMatchObject({
      text: "actual document",
    });
    expect((await old.getPrompt({ name: "review" })).messages[0]?.content).toEqual({
      type: "text",
      text: "actual prompt",
    });
    await service.drainInvalidations(); // Historical events must preserve currently authorized sessions.
    expect((await old.listTools()).tools[0]?.name).toBe("counter");
    await leases.invalidateSandbox(sandbox);
    await expect(old.callTool({ name: "counter" })).rejects.toThrow();
    const freshToken = await issue();
    const fresh = await connect(freshToken);
    expect((await fresh.callTool({ name: "counter" })).content).toEqual([{ type: "text", text: "2" }]);
    await service.drainInvalidations();
    await eof(oldToken);
    expect((await fresh.listTools()).tools[0]?.name).toBe("counter"); // New-generation streams survive late restore events.
    replica2 = createMcpHttpIntegration({
      sql: db,
      authStore,
      encryptionKey,
      publicUrl: "https://gateway.example",
      providerForSandbox: async (id) => {
        expect(id).toBe(sandbox);
        if (!nativeProvider) throw Error("Native provider not ready");
        return nativeProvider;
      },
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
      fetch: upstreamFetch,
    });
    const secondToken = await issue();
    const second = await connect(secondToken, replica2);
    expect((await second.listTools()).tools[0]?.name).toBe("counter");
    await post("set-enabled", { id, enabled: false });
    await Promise.all([service.drainInvalidations(), replica2.drainInvalidations()]);
    await Promise.all([eof(freshToken), eof(secondToken)]);
    expect(
      (
        await db.query<{ replicas: number }>(
          "select count(distinct replica_id)::integer as replicas from public.mcp_invalidation_deliveries",
        )
      ).rows[0]?.replicas,
    ).toBe(2);
    await expect(fresh.callTool({ name: "counter" })).rejects.toThrow();
    expect(calls).toBe(2);
    // Restore a fresh, really probed grant before exercising the private native-config bridge.
    await post("set-enabled", { id, enabled: true });
    await post("connect", { id });
    let boot = "11111111-1111-4111-8111-111111111111",
      writes = 0,
      failInstall = false;
    let physicalState: "ready" | "stopped" = "ready";
    let nativeTurns = 0;
    const physicalExpiry = new Date(Date.now() + 6 * 3600000);
    const provider = {
      id: "modal",
      get: async () => ({
        id: record.providerSandboxId,
        state: physicalState,
        expiresAt: physicalExpiry,
        physicalGeneration: boot,
      }),
      stop: async () => {
        physicalState = "stopped";
      },
      prompt: async () => {
        // Provider fixture models actual resume BEFORE the real backend callback/native turn.
        physicalState = "ready";
        boot = "33333333-3333-4333-8333-333333333333";
        await service.beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org });
        const row = (
          await db.query<{ status: string; stopped_at: Date | null }>(
            "select status,stopped_at from public.sandboxes where id=$1",
            [sandbox],
          )
        ).rows[0];
        expect(row).toMatchObject({ status: "ready", stopped_at: null });
        nativeTurns++;
        return { conversationId: "resume-conversation", promptId: "resume-prompt", status: "queued" };
      },
      configureMcp: async ({ configuration }: { configuration: unknown }) => {
        if (failInstall) throw Error("Native configuration I/O failed");
        const child = Bun.spawn(["bash"], {
          stdin: new Blob([nativeMcpInstallScript]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify(configuration) },
        });
        expect(await child.exited).toBe(0);
        writes++;
      },
    } as unknown as Provider;
    nativeProvider = provider;
    const createLifecycle = () =>
      createMcpLifecycle({ sql: db, registry: service.registry, encryptionKey, origin: "https://gateway.example" });
    const lifecycle = createLifecycle();
    await Promise.all([
      lifecycle.connections.prepare?.(provider, record, { userId: user, orgId: org, role: "admin" }),
      lifecycle.connections.prepare?.(provider, record, { userId: user, orgId: org, role: "admin" }),
    ]);
    const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    const installed = Object.values(config.mcpServers)[0];
    if (!installed) throw Error("Native config not installed");
    const firstHash = await sha256Hex(installed.headers.Authorization.slice(7));
    expect(await leases.validate(firstHash, "tools")).not.toBeNull();
    expect(writes).toBe(1);
    await createLifecycle().beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org });
    expect(writes).toBe(1); // Restart reconstructs/reuses, never rotates active parallel conversations.
    expect(await leases.validate(firstHash, "tools")).not.toBeNull();
    const expiry = (
      await db.query<{ expires_at: Date }>("select expires_at from public.mcp_leases where hash=$1", [firstHash])
    ).rows[0]?.expires_at;
    expect(new Date(expiry ?? 0).getTime()).toBe(physicalExpiry.getTime());
    physicalExpiry.setTime(Date.now() + 30 * 3600000);
    await lifecycle.beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org });
    const bounded = (
      await db.query<{ expires_at: Date }>("select expires_at from public.mcp_leases where hash=$1", [firstHash])
    ).rows[0]?.expires_at;
    expect(new Date(bounded ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600000);
    expect(new Date(bounded ?? 0).getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);
    expect(writes).toBe(1);
    boot = "22222222-2222-4222-8222-222222222222";
    failInstall = true;
    await expect(
      lifecycle.beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org }),
    ).rejects.toThrow("I/O failed");
    expect(await leases.validate(firstHash, "tools")).toBeNull(); // Failure cannot roll back the physical-generation fence.
    failInstall = false;
    await lifecycle.beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org });
    const restored = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as typeof config;
    const restoredServer = Object.values(restored.mcpServers)[0];
    if (!restoredServer) throw Error("Restore config missing");
    expect(
      await leases.validate(await sha256Hex(restoredServer.headers.Authorization.slice(7)), "tools"),
    ).not.toBeNull();
    expect(await leases.validate(firstHash, "tools")).toBeNull();
    const restoredHash = await sha256Hex(restoredServer.headers.Authorization.slice(7));
    failInstall = true;
    await expect(lifecycle.beforeSnapshot(provider, record.providerSandboxId)).rejects.toThrow("I/O failed");
    expect(await leases.validate(restoredHash, "tools")).toBeNull();
    failInstall = false;
    await lifecycle.beforeSnapshot(provider, record.providerSandboxId);
    expect((await readFile(join(home, ".claude.json"), "utf8")).includes("armada_gw_")).toBe(false);
    expect((await readFile(join(home, ".codex/config.toml"), "utf8")).includes("armada_gw_")).toBe(false);
    // An advanced credential is verified upstream, but only a newly scoped lease reaches native config.
    upstreamCredential = crypto.randomUUID();
    await post("update", {
      id,
      name: "Advanced service",
      scope: "personal",
      transport: "http",
      url: "https://upstream.example/mcp?project_ref=demo&read_only=true",
      authType: "bearer",
      authentication: upstreamCredential,
    });
    const connected = await post("connect", { id });
    expect(connected.connection.status).toBe("connected");
    expect(JSON.stringify(connected).includes(upstreamCredential)).toBe(false);
    await lifecycle.beforePrompt(provider, record.providerSandboxId, { userId: user, orgId: org });
    for (const file of [".claude.json", ".codex/config.toml", ".armada/mcp-owned.json"])
      expect((await readFile(join(home, file), "utf8")).includes(upstreamCredential)).toBe(false);
    const advancedToken = await issue();
    const advanced = await connect(advancedToken);
    expect((await advanced.callTool({ name: "counter" })).content).toEqual([{ type: "text", text: "3" }]);
    const writesBeforeRenewal = writes;
    await service.renewActiveLeases();
    const renewed = (
      await db.query<{ expires_at: Date }>("select expires_at from public.mcp_leases where hash=$1", [
        await sha256Hex(advancedToken),
      ])
    ).rows[0]?.expires_at;
    expect(new Date(renewed ?? 0).getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);
    expect(new Date(renewed ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600000);
    expect(writes).toBe(writesBeforeRenewal);
    upstreamUnavailable = true;
    expect((await post("status", { id })).connection.status).toBe("unavailable");
    expect((await service.registry.get(user, org, id)).status).toBe("unavailable");
    upstreamUnavailable = false;
    expect((await post("status", { id })).connection).toMatchObject({
      status: "connected",
      toolCount: 1,
      resourceCount: 1,
      promptCount: 1,
    });
    expect(await leases.validate(restoredHash, "tools")).toBeNull();
    await lifecycle.beforeSnapshot(provider, record.providerSandboxId);
    const control = {
      authStore,
      supabase: { supabaseUrl: "https://auth.example", anonKey: "public" },
      store: createSqlVaultStore(db),
      encryptionKey,
      data: createSqlData(db),
      providers: { resolve: async () => provider },
    };
    const controlPost = async (action: string, body: object) => {
      const response = await handleControlRequest(
        new Request(`https://gateway.example/api/v1/sandbox/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${armadaToken}` },
          body: JSON.stringify({ org, id: sandbox, ...body }),
        }),
        control,
      );
      if (!response) throw Error("Missing sandbox control route");
      return response;
    };
    expect((await controlPost("stop", {})).status).toBe(200);
    const stopped = (
      await db.query<{ status: string; stopped_at: Date | null }>(
        "select status,stopped_at from public.sandboxes where id=$1",
        [sandbox],
      )
    ).rows[0];
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stopped_at).not.toBeNull();
    expect((await controlPost("send", { prompt: "resume the connected sandbox" })).status).toBe(200);
    expect(nativeTurns).toBe(1);
    expect(
      (
        await db.query<{ status: string; stopped_at: Date | null }>(
          "select status,stopped_at from public.sandboxes where id=$1",
          [sandbox],
        )
      ).rows[0],
    ).toMatchObject({ status: "running", stopped_at: null });
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await integration?.close();
    await replica2?.close();
    await Promise.all([...readers.values()].map((reader) => reader.cancel().catch(() => {})));
    await Promise.all(servers.map((s) => s.close()));
    await db.close();
    await rm(home, { recursive: true, force: true });
  }
});
