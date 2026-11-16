import { expect, spyOn, test } from "bun:test";
import { createServiceToken, createSqlAuthStore, sha256Hex } from "@armada/auth";
import type { Provider } from "@armada/core/server";
import {
  createSqlMcpLaunchPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  createSqlSandboxStore,
  createSqlVaultStore,
  encryptSecret,
  setCredential,
} from "@armada/core/server";
import { createSqlModalStore, type Machine, type Scope, scopeKey } from "@armada/provider-modal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type App, AppService, type Sandbox, SandboxService } from "modal";
import { handleControlRequest } from "../src/control.ts";
import { createSqlData } from "../src/data.ts";
import { providerRegistry } from "../src/http.ts";
import { createMcpHttpIntegration } from "../src/mcp-http-integration.ts";
import { createMcpOAuthStore, createMcpSecretBox } from "../src/mcp-integration.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import type { McpBootstrap } from "../src/mcp-native.ts";
import { createMcpSandboxProviderResolver } from "../src/mcp-sandbox-provider.ts";
import { createModalIntegration } from "../src/modal-integration.ts";
import { rowOnlyConnection } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const connection = rowOnlyConnection();

// Distinct integration risk: real SQL grants/leases, real control discovery/capability counts,
// and SDK protocol delivery must agree, including generation rotation and registry disable.
test("SQL gateway delivers MCP objects and provider configuration is reused across concurrent starts/restart, rotating only on physical restore", async () => {
  const db = await connection();
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
    const vault = createSqlVaultStore(db);
    await setCredential(vault, encryptionKey, user, {
      scope: "user",
      org: undefined,
      kind: "openai",
      value: "synthetic-model-account",
    });
    const account = (await vault.listCredentials("user", user))[0]!;
    const record = await createSqlSandboxStore(db).insert({
      credentialId: account.id!,
      credentialVersion: account.version!,
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
    // Native file formats/rotation/scrub belong to mcp-native.test.ts; capture real provider delivery here.
    const nativeConfigurations: McpBootstrap[] = [];
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
      configureMcp: async ({ configuration }: { configuration: McpBootstrap }) => {
        if (failInstall) throw Error("Native configuration I/O failed");
        nativeConfigurations.push(structuredClone(configuration));
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
    const config = nativeConfigurations.at(-1);
    if (!config) throw Error("Native config not delivered");
    const installed = Object.values(config.servers)[0];
    if (!installed || installed.type !== "http" || !installed.headers?.Authorization)
      throw Error("Native gateway credential not delivered");
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
    const restored = nativeConfigurations.at(-1);
    if (!restored) throw Error("Restore config missing");
    const restoredServer = Object.values(restored.servers)[0];
    if (!restoredServer || restoredServer.type !== "http" || !restoredServer.headers?.Authorization)
      throw Error("Restore gateway credential missing");
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
    expect(nativeConfigurations.at(-1)).toEqual({ revision: "snapshot_scrub", servers: {} });
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
    expect(JSON.stringify(nativeConfigurations)).not.toContain(upstreamCredential);
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
    expect((await controlPost("send", { prompt: "terminal refusal" })).status).toBe(409);
    await db.query("update sandboxes set status_reason='idle_paused' where id=$1", [sandbox]);
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
  }
});

// Real SQL -> production renewal resolver -> registry -> composed Modal adapter -> SQL machine
// scope -> physical SDK poll -> lease UPDATE. The SDK alone is replaced; no cloud authority.
test("MCP renewal finds a private Modal machine forked from an org golden with its pinned org credentials", async () => {
  const db = await connection();
  const people = { org: crypto.randomUUID(), owner: crypto.randomUUID(), admin: crypto.randomUUID() };
  const binding = { workspace: "app:ap-renew", environment: "main", appId: "ap-renew" };
  const apps = spyOn(AppService.prototype, "fromName").mockImplementation(async (name, options) => {
    expect(name).toBe("renew-org-app");
    expect(options).toEqual({ environment: "main", createIfMissing: false });
    return { appId: binding.appId } as App;
  });
  let polls = 0;
  const physicals = spyOn(SandboxService.prototype, "fromId").mockImplementation(async (id) => {
    expect(id).toBe("sb-renew-physical");
    return {
      poll: async () => {
        polls++;
        return null;
      },
    } as unknown as Sandbox;
  });
  try {
    await db.query("insert into auth.users(id) values($1),($2)", [people.owner, people.admin]);
    await db.query("insert into orgs(id,name) values($1,'MCP renewal')", [people.org]);
    // Keep another member after owner revocation; any-org-member authorization must still fail.
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'admin')", [
      people.org,
      people.owner,
      people.admin,
    ]);
    await db.query(
      "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'org',$1,'renew-org-app',$3,'main')",
      [people.org, `org:${people.org}`, binding.appId],
    );
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'modal',$2)", [
      people.org,
      await encryptSecret(
        JSON.stringify({ token_id: "ak-reneworganization", token_secret: "as-reneworganization" }),
        ENCRYPTION_KEY,
      ),
    ]);
    // Invalid personal credentials must never override the org source's pinned credential slot.
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'modal',$2)", [
      people.owner,
      await encryptSecret("invalid-personal-pair", ENCRYPTION_KEY),
    ]);
    const golden = crypto.randomUUID(),
      sandbox = crypto.randomUUID();
    await db.query(
      "insert into goldens(id,org_id,owner_id,name,visibility,provider,modal_workspace,modal_environment,modal_app_id) values($1,$2,$3,'renew-source','org','modal',$4,'main',$5)",
      [golden, people.org, people.admin, binding.workspace, binding.appId],
    );
    await createSqlSandboxStore(db).insert({
      id: sandbox,
      provider: "modal",
      providerSandboxId: "bx-renew",
      goldenId: golden,
      orgId: people.org,
      ownerId: people.owner,
      visibility: "private",
      harness: "codex",
      status: "ready",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    const scope: Scope = { orgId: people.org, userId: people.owner, visibility: "private", binding };
    const expiry = new Date(Date.now() + 6 * 3600000);
    const machine: Machine = {
      info: {
        id: "bx-renew",
        name: "private fork",
        state: "ready",
        providerState: "active",
        labels: {},
        expiresAt: expiry,
      },
      phase: "active",
      generation: 1,
      golden: false,
      ttlSeconds: 21600,
      physicalId: "sb-renew-physical",
      physicalName: "private-fork",
      launchUserId: people.owner,
      managementAuthority: { credentialScope: "org", credentialOwnerId: people.org },
      sourceImage: { scopeKey: scopeKey({ ...scope, visibility: "org" }), name: "source", imageId: "im-source" },
    };
    await createSqlModalStore(db, scope).reserve("private-fork", machine);
    const connection = crypto.randomUUID(),
      grant = crypto.randomUUID(),
      lease = crypto.randomUUID();
    // One bounded setup statement; the returned IDs preserve FK dependencies.
    await db.query(
      `with connection as (
        insert into mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type)
        values($1,$2,$3,'personal','renew','http','https://mcp.example','none') returning id
      ), connected_grant as (
        insert into mcp_grants(id,connection_id,status)
        select $4,id,'connected' from connection returning id,connection_id
      )
      insert into mcp_bindings(sandbox_id,connection_id,grant_id)
      select $5,connection_id,id from connected_grant`,
      [connection, people.org, people.owner, grant, sandbox],
    );
    await db.query(
      "insert into mcp_bootstraps(sandbox_id,physical_generation,revision,configured) values($1,$2,'installed',true)",
      [sandbox, JSON.stringify(["modal", "bx-renew", "1"])],
    );
    const before = new Date(Date.now() + 60000);
    await db.query(
      "insert into mcp_leases(id,sandbox_id,connection_id,grant_id,org_id,owner_id,generation,sandbox_generation,hash,operations,expires_at) values($1,$2,$3,$4,$5,$6,1,1,$7,array['tools'],$8)",
      [lease, sandbox, connection, grant, people.org, people.owner, "a".repeat(64), before],
    );
    const vault = createSqlVaultStore(db);
    const modal = await createModalIntegration({
      sql: db,
      vault,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
    });
    const registry = providerRegistry({
      vault,
      encryptionKey: ENCRYPTION_KEY,
      providerFor: () => {
        throw Error("Unexpected Boat fallback");
      },
      modalTokensFor: modal.modalTokensFor,
      modalProviderFor: modal.modalProviderFor,
    });
    const resolve = createMcpSandboxProviderResolver(db, registry);
    const lifecycle = createMcpLifecycle({
      sql: db,
      encryptionKey: ENCRYPTION_KEY,
      origin: "https://armada.test",
      registry: createSqlMcpRegistry(db, ENCRYPTION_KEY),
    });
    await lifecycle.connections.renewLifetime?.(await resolve(sandbox), sandbox);
    const renewed = (await db.query<{ expires_at: Date }>("select expires_at from mcp_leases where id=$1", [lease]))
      .rows[0];
    expect(new Date(renewed?.expires_at ?? 0).getTime()).toBe(expiry.getTime());
    expect(polls).toBe(1);
    await db.query("delete from members where org_id=$1 and user_id=$2", [people.org, people.owner]);
    await expect(resolve(sandbox)).rejects.toThrow("No authorized active sandbox");
    expect(
      new Date(
        (await db.query<{ expires_at: Date }>("select expires_at from mcp_leases where id=$1", [lease])).rows[0]
          ?.expires_at ?? 0,
      ).getTime(),
    ).toBe(expiry.getTime());
    expect(polls).toBe(1);
  } finally {
    apps.mockRestore();
    physicals.mockRestore();
  }
});

test("SQL OAuth store fences callback replay, concurrent initial grants, consumed refresh and revocation", async () => {
  const db = await connection();
  const actor = crypto.randomUUID(),
    other = crypto.randomUUID(),
    org = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.query(`insert into auth.users(id) values($1),($2)`, [actor, other]);
  await db.query(`insert into public.orgs(id,name) values($1,'MCP test')`, [org]);
  await db.query(`insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member')`, [
    org,
    actor,
    other,
  ]);
  await db.query(
    `insert into public.mcp_connections(id,org_id,owner_id,scope,name,transport,url,auth_type) values($1,$2,$3,'personal','Example','http','https://example.com/mcp','oauth')`,
    [id, org, actor],
  );
  await db.query(`insert into public.mcp_grants(connection_id) values($1)`, [id]);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const box = createMcpSecretBox(key),
    store = createMcpOAuthStore(db, key);
  const generation = await store.generation(id);
  const sealed = await box.seal(JSON.stringify({ access: crypto.randomUUID(), generation }));
  expect(await box.open(sealed)).toContain("access");
  const state = "ab".repeat(32);
  await store.putPending(state, { actorId: actor, connectionId: id, expiresAt: Date.now() + 60000, sealed });
  expect(await store.takePending(state, other, Date.now())).toBeNull();
  expect((await store.takePending(state, actor, Date.now()))?.sealed).toBe(sealed);
  expect(await store.takePending(state, actor, Date.now())).toBeNull();
  expect(await store.saveGrant(id, null, sealed, generation)).toBe(false); // No unbound initial publication.
  const actorStore = createMcpOAuthStore(db, key, actor);
  await store.putPending("ac".repeat(32), {
    actorId: actor,
    connectionId: id,
    expiresAt: Date.now() + 60000,
    sealed,
  });
  expect(await actorStore.takePending("ac".repeat(32), actor, Date.now())).not.toBeNull();
  expect(await actorStore.saveGrant(id, null, sealed, generation)).toBe(true);
  expect(await actorStore.saveGrant(id, null, sealed, generation)).toBe(false);
  const saved = await store.readGrant(id);
  if (!saved) throw Error("Missing persisted grant");
  const owner = crypto.randomUUID();
  expect(await store.claimRefresh(id, saved.version, generation, owner)).toBe(true);
  expect(await store.claimRefresh(id, saved.version, generation, crypto.randomUUID())).toBe(false);
  // Expired/ambiguous ownership cannot be reclaimed: upstream refresh might have consumed its token.
  await db.query(`update public.mcp_grants set refresh_until=now()-interval '1 second' where connection_id=$1`, [id]);
  expect(await store.claimRefresh(id, saved.version, generation, crypto.randomUUID())).toBe(false);
  expect(await store.readGrant(id)).toBeNull();
  expect(await store.saveGrant(id, saved.version, sealed, generation, owner)).toBe(false);
  await db.query(`update public.mcp_grants set generation=generation+1 where connection_id=$1`, [id]);
  await expect(
    store.putPending("cd".repeat(32), { actorId: actor, connectionId: id, expiresAt: Date.now() + 60000, sealed }),
  ).rejects.toThrow("no longer authorized");
  await store.revoke(id);
  expect(await store.readGrant(id)).toBeNull();
  expect(await store.saveGrant(id, saved.version, sealed, generation, owner)).toBe(false);
  // An admin may lose its role while the upstream exchange is in flight, AFTER state was taken.
  // The grant belongs to another admin, so a grant-generation check alone cannot cover this race.
  await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [org, other]);
  const shared = await createSqlMcpRegistry(db, key).save(other, org, {
    name: "Shared OAuth",
    scope: "org",
    transport: "http",
    url: "https://example.com/shared",
    authType: "oauth",
  });
  const callbackStore = createMcpOAuthStore(db, key, actor);
  const sharedGeneration = await store.generation(shared.id);
  const pendingSeal = await box.seal(JSON.stringify({ generation: sharedGeneration }));
  await callbackStore.putPending("ef".repeat(32), {
    actorId: actor,
    connectionId: shared.id,
    expiresAt: Date.now() + 60000,
    sealed: pendingSeal,
  });
  expect(await callbackStore.takePending("ef".repeat(32), actor, Date.now())).not.toBeNull();
  await db.query("update public.members set role='member' where org_id=$1 and user_id=$2", [org, actor]);
  expect(await store.generation(shared.id)).toBe(sharedGeneration);
  expect(await callbackStore.saveGrant(shared.id, null, sealed, sharedGeneration)).toBe(false);
});
