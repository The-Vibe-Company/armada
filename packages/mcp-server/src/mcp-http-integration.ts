import type { AuthStore } from "@armada/auth";
import {
  createSqlMcpGrantPort,
  createSqlMcpInvalidationPort,
  createSqlMcpLeasePort,
  createSqlMcpRegistry,
  decryptSecret,
  type McpConnectionInput,
  McpStdioError,
  type Provider,
  parsePinnedMcpStdio,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  createClientMetadataHandler,
  createMcpGateway,
  createOAuthBroker,
  createRemoteAuthResolver,
  GatewayError,
  type GatewayLease,
  publicFetch,
} from "../../mcp-gateway/src/index.ts";
import { AuthUnavailable, authenticateCaller, bearerToken, type SupabaseProject } from "./caller.ts";
import { dashboardOrigin } from "./config.ts";
import { createGitHubRuntime } from "./github-runtime.ts";
import { SLACK_OAUTH_BINDING } from "./mcp-catalog-client.ts";
import { createMcpOAuthStore, createMcpSecretBox } from "./mcp-integration.ts";
import { createMcpLifecycle } from "./mcp-lifecycle.ts";
import { boundedOAuthFetch, probeRemoteMcp, withMcpDiscoveryBudget } from "./mcp-probe.ts";

const sha = async (v: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))).toString("hex");
/** Production HTTP adapter. Upstream grants never cross the gateway/native boundary. */
export function createMcpHttpIntegration(options: {
  sql: Sql;
  github?: import("@armada/core/server").GitHubResolveDeps;
  encryptionKey: string | undefined;
  publicUrl: string;
  dashboardUrl?: string;
  /** Trusted server configuration only; production defaults to HTTPS callbacks. */
  development?: boolean;
  /** Trusted outbound transport, e.g. deployment egress proxy; endpoint policy remains enforced. */
  fetch?: typeof publicFetch;
  authStore: AuthStore;
  supabase: SupabaseProject;
  catalogAuthentication?: (serviceId: import("@armada/core").McpCatalogId) => Promise<string | undefined>;
  /** Trusted persisted-identity resolver for renewing an ongoing physical VM turn. */
  providerForSandbox?: (sandboxId: string) => Promise<Provider>;
}) {
  const { sql } = options;
  const networkFetch = options.fetch ?? publicFetch;
  const oauthFetch = boundedOAuthFetch(networkFetch);
  const registry = createSqlMcpRegistry(sql, options.encryptionKey, {
    ...(options.catalogAuthentication ? { catalogAuthentication: options.catalogAuthentication } : {}),
  });
  const githubRuntime =
    options.github && options.providerForSandbox
      ? createGitHubRuntime({
          sql,
          github: options.github,
          origin: new URL(options.publicUrl).origin,
          providerForSandbox: options.providerForSandbox,
        })
      : undefined;
  const lifecycle = createMcpLifecycle({
    sql,
    registry,
    ...(githubRuntime ? { prepareGitHub: githubRuntime.prepare } : {}),
    encryptionKey: options.encryptionKey,
    origin: new URL(options.publicUrl).origin,
  });
  const grants = createSqlMcpGrantPort(sql);
  const store = createMcpOAuthStore(sql, options.encryptionKey);
  const vault = createMcpSecretBox(options.encryptionKey);
  const leases = createSqlMcpLeasePort(sql);
  const invalidations = createSqlMcpInvalidationPort(sql);
  const replica = crypto.randomUUID();
  const publicAddress = new URL(options.publicUrl);
  const origin = publicAddress.origin;
  // This server mount may sit behind a TLS terminator. Trust configured authority,
  // never X-Forwarded-*; the standalone gateway remains strict about its origin.
  function gatewayIngress(request: Request): Request | null {
    const inbound = new URL(request.url);
    if (inbound.username || inbound.password) return null;
    if (inbound.origin === origin) return request;
    if (publicAddress.protocol !== "https:" || inbound.protocol !== "http:" || inbound.host !== publicAddress.host)
      return null;
    const host = request.headers.get("host");
    if (!host || /[\s/@?#\\]/.test(host)) return null;
    let authority: URL;
    try {
      authority = new URL(`https://${host}`);
    } catch {
      return null;
    }
    if (authority.host !== publicAddress.host || authority.pathname !== "/") return null;
    const canonical = new URL(inbound.href);
    canonical.protocol = publicAddress.protocol;
    canonical.host = publicAddress.host;
    return new Request(canonical.href, request);
  }
  const redirectUri = `${dashboardOrigin(options.dashboardUrl, options.development === true)}/auth/mcp/callback`;
  const clientMetadataUrl = `${origin}/.well-known/armada-mcp-client.json`;
  const metadata = createClientMetadataHandler({ redirectUri, clientMetadataUrl });
  async function definition(id: string, allowRevoked = false) {
    const r = await sql.query<{
      org_id: string;
      owner_id: string;
      scope: string;
      url: string;
      transport: "http" | "sse" | "stdio";
      auth_type: string;
      value_enc: Uint8Array<ArrayBuffer> | null;
      generation: number;
    }>(
      `select c.*,g.value_enc,g.generation from public.mcp_connections c join public.mcp_grants g on g.connection_id=c.id where c.id=$1::uuid and not c.disabled and (g.revoked_at is null or $2::boolean)`,
      [id, allowRevoked],
    );
    if (!r.rows[0]) throw new GatewayError("denied", "Connection disabled or revoked. Reconnect.");
    return r.rows[0];
  }
  const broker = createOAuthBroker({
    store,
    vault,
    redirectUri,
    development: options.development === true,
    clientMetadataUrl,
    fetch: oauthFetch,
    authorize: async (actor, id) => {
      const c = await definition(id);
      await registry.get(actor, c.org_id, id);
    },
  });
  function vettedHeaders(headers: Headers): Headers {
    for (const key of headers.keys())
      if (
        ["host", "cookie", "proxy-authorization", "mcp-session-id", "connection", "content-length"].includes(
          key.toLowerCase(),
        )
      )
        throw new GatewayError(
          "unsupported",
          "Authentication uses a transport-owned header. Use bearer or supported custom headers.",
        );
    return headers;
  }
  async function probe(id: string, user: string, signal?: AbortSignal) {
    const c = await definition(id);
    if (c.transport === "stdio") return {};
    return probeRemoteMcp({
      url: c.url,
      transport: c.transport,
      fetch: networkFetch,
      ...(signal ? { signal } : {}),
      headers: async (fetch) => {
        const headers = new Headers();
        if (c.auth_type === "oauth") {
          const scoped = createOAuthBroker({
            store,
            vault,
            redirectUri,
            development: options.development === true,
            clientMetadataUrl,
            fetch,
            authorize: async (actor, id) => {
              const current = await definition(id);
              await registry.get(actor, current.org_id, id);
            },
          });
          headers.set("authorization", `Bearer ${await scoped.access(user, id, c.url)}`);
        } else if (c.auth_type === "bearer" || c.auth_type === "headers") {
          if (!c.value_enc) throw new GatewayError("needs_reconnect", "Configure authentication.");
          const value = await decryptSecret(c.value_enc, options.encryptionKey);
          if (c.auth_type === "bearer") headers.set("authorization", `Bearer ${value}`);
          else for (const [key, header] of Object.entries(JSON.parse(value))) headers.set(key, String(header));
        }
        return vettedHeaders(headers);
      },
    });
  }

  async function connectionStatus(user: string, org: string, id: string, signal?: AbortSignal) {
    const dto = await registry.get(user, org, id);
    if (!["connected", "unavailable"].includes(dto.status) || dto.transport === "stdio") return dto;
    const initial = await definition(id);
    try {
      const counts = await probe(id, user, signal);
      await sql.query(
        `update public.mcp_grants g set status='connected' where connection_id=$1::uuid and generation=$2 and revoked_at is null and not (refresh_consumed and refresh_until<=now()) and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and not c.disabled)`,
        [id, initial.generation],
      );
      return { ...(await registry.get(user, org, id)), ...counts };
    } catch (error) {
      const status =
        error instanceof GatewayError && error.code === "needs_reconnect" ? "needs_reconnect" : "unavailable";
      await sql.query(
        `update public.mcp_grants g set status=$3 where connection_id=$1::uuid and generation=$2 and revoked_at is null and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and not c.disabled)`,
        [id, initial.generation, status],
      );
      return {
        ...(await registry.get(user, org, id)),
        lastError:
          error instanceof GatewayError
            ? error.action
            : "MCP probe failed. Verify endpoint, authentication and transport; reconnect if needed.",
      };
    }
  }
  async function connectConnection(userId: string, org: string, id: string, signal?: AbortSignal) {
    const dto = await registry.get(userId, org, id);
    if (
      dto.scope === "org" &&
      !(
        await sql.query("select 1 from public.members where org_id=$1::uuid and user_id=$2::uuid and role='admin'", [
          org,
          userId,
        ])
      ).rows.length
    )
      throw new GatewayError("denied", "Administrator permission required to connect a shared MCP grant.");
    if (dto.status === "disabled") throw new GatewayError("denied", "Enable this connection before reconnecting.");
    const c = await definition(id, true);
    if (c.transport === "stdio") {
      parsePinnedMcpStdio(dto.command ?? "", dto.args ?? []);
      return { connection: dto.status === "connected" ? dto : await registry.configureStdio(userId, org, id) };
    }
    if (dto.status === "not_connected" && c.auth_type !== "oauth") {
      const snapshot = await sql.query<{ revoked_at: Date | null }>(
        "select revoked_at from public.mcp_grants where connection_id=$1::uuid",
        [id],
      );
      if (snapshot.rows[0]?.revoked_at) {
        const begun = await grants.begin(id);
        if (!begun) throw new GatewayError("denied", "Connection changed; reconnect.");
        c.generation = begun.generation;
        c.value_enc = begun.value_enc;
      }
    }
    let authorizationUrl: string | undefined;
    let metadata: Awaited<ReturnType<typeof probe>> | undefined;
    if (c.auth_type === "auto") {
      const discovered = await withMcpDiscoveryBudget(networkFetch, signal, (fetch) =>
        createRemoteAuthResolver({ fetch })({
          url: c.url,
          transport: c.transport as "http" | "sse",
          ...(signal ? { signal } : {}),
        }),
      );
      if (!(await grants.discovered(id, c.generation, discovered.authType)))
        throw new GatewayError("denied", "Connection changed during discovery. Reconnect.");
      c.auth_type = discovered.authType;
    }
    if (c.auth_type === "oauth") {
      let client: Parameters<typeof broker.connect>[0]["client"];
      const registered = dto.catalogId === "slack" ? await options.catalogAuthentication?.("slack") : undefined;
      if (dto.catalogId === "slack" && !registered)
        throw new VaultError("unavailable", "Slack registered client deployment setup required.");
      if (registered || c.value_enc) {
        const stored = JSON.parse(registered ?? (await decryptSecret(c.value_enc!, options.encryptionKey)));
        const registration = stored.client ?? stored;
        if (
          registration.redirect_uris !== undefined &&
          (!Array.isArray(registration.redirect_uris) ||
            registration.redirect_uris.length !== 1 ||
            registration.redirect_uris[0] !== redirectUri)
        )
          throw new GatewayError("denied", "Preregistered client must use the fixed dashboard callback.");
        client = OAuthClientInformationFullSchema.parse({ ...registration, redirect_uris: [redirectUri] });
        if (!client.issuer || !client.client_id)
          throw new GatewayError("denied", "Preregistration requires an exact issuer and client ID.");
      }
      if (!(await grants.begin(id))) throw new GatewayError("denied", "Connection changed; reconnect.");
      authorizationUrl = (
        await withMcpDiscoveryBudget(networkFetch, signal, (fetch) =>
          createOAuthBroker({
            store,
            vault,
            redirectUri,
            development: options.development === true,
            clientMetadataUrl,
            fetch,
            authorize: async (user, id) => {
              const c = await definition(id);
              await registry.get(user, c.org_id, id);
            },
          }).connect({
            actorId: userId,
            connectionId: id,
            resource: c.url,
            ...(client ? { client } : {}),
            ...(dto.catalogId === "slack"
              ? {
                  binding: SLACK_OAUTH_BINDING,
                  ...(client && "scope" in client && client.scope ? { scope: client.scope } : {}),
                }
              : {}),
          }),
        )
      ).authorizationUrl;
    } else {
      try {
        metadata = await probe(id, userId, signal);
      } catch (error) {
        await sql.query(
          `update public.mcp_grants g set status=$3 where connection_id=$1::uuid and generation=$2 and revoked_at is null and exists(select 1 from public.mcp_connections c where c.id=g.connection_id and not c.disabled)`,
          [
            id,
            c.generation,
            error instanceof GatewayError && error.code === "needs_reconnect" ? "needs_reconnect" : "unavailable",
          ],
        );
        throw error;
      }
      const published = await sql.query(
        `update public.mcp_grants set status='connected',version=version+1 where connection_id=$1::uuid and generation=$2 and revoked_at is null returning id`,
        [id, c.generation],
      );
      if (!published.rows.length) throw new GatewayError("denied", "Connection changed during probe. Reconnect.");
    }
    return {
      connection: {
        ...(await registry.get(userId, org, id)),
        ...(metadata ?? {}),
      },
      ...(authorizationUrl ? { authorizationUrl } : {}),
    };
  }
  async function completeCallback(userId: string, state: string, code: string, issuer?: string, signal?: AbortSignal) {
    let connectionId: string | undefined;
    await withMcpDiscoveryBudget(oauthFetch, signal, async (fetch, signal) => {
      const actorStore = createMcpOAuthStore(sql, options.encryptionKey, userId, signal);
      const callbackBroker = createOAuthBroker({
        store: {
          ...actorStore,
          takePending: async (...args) => {
            const flow = await actorStore.takePending(...args);
            connectionId = flow?.connectionId;
            return flow;
          },
        },
        vault,
        redirectUri,
        development: options.development === true,
        clientMetadataUrl,
        fetch,
        authorize: async (user, id) => {
          const c = await definition(id);
          await registry.get(user, c.org_id, id);
        },
      });
      await callbackBroker.callback({
        actorId: userId,
        state,
        code,
        ...(issuer ? { issuer } : {}),
      });
    });
    if (!connectionId) throw new Error("No callback connection");
    const c = await definition(connectionId);
    return connectionStatus(userId, c.org_id, connectionId, signal);
  }
  const hashes = new WeakMap<GatewayLease, string>();
  const activeLeases = new Map<string, { lease: GatewayLease; hash: string; orgId: string }>();
  async function validate(lease: GatewayLease, op = "tools") {
    const hash = hashes.get(lease);
    if (!hash || !(await leases.validate(hash, op)))
      throw new GatewayError("denied", "Gateway lease is no longer active. Reconcile sandbox connections.");
  }
  const gateway = createMcpGateway({
    origin,
    fetch: networkFetch,
    authorization: {
      async authenticate(request) {
        const token = bearerToken(request.headers.get("authorization"));
        if (!token) throw new GatewayError("denied", "Gateway token required.");
        const hash = await sha(token);
        const claims = await leases.validate(hash, "tools");
        if (!claims) throw new GatewayError("denied", "Gateway token revoked or expired.");
        const c = await definition(claims.connection_id);
        if (c.transport === "stdio")
          throw new GatewayError("denied", "Stdio runs in the sandbox, never on this server.");
        if (new URL(request.url).pathname !== `/mcp/gateway/${claims.connection_id}`)
          throw new GatewayError("denied", "Connection mismatch.");
        const r = await sql.query<{ expires_at: Date }>("select expires_at from public.mcp_leases where id=$1::uuid", [
          claims.id,
        ]);
        const lease: GatewayLease = {
          id: claims.id,
          actorId: claims.owner_id,
          sandboxId: claims.sandbox_id,
          connectionId: claims.connection_id,
          expiresAt: new Date(r.rows[0]?.expires_at ?? 0).getTime(),
          url: c.url,
          transport: c.transport,
        };
        const previous = activeLeases.get(lease.id);
        if (previous) {
          if (
            previous.hash !== hash ||
            previous.lease.connectionId !== lease.connectionId ||
            previous.lease.url !== lease.url ||
            previous.lease.transport !== lease.transport
          )
            throw new GatewayError("denied", "Lease target changed. Reconcile sandbox connections.");
          previous.lease.expiresAt = lease.expiresAt;
          return previous.lease;
        }
        hashes.set(lease, hash);
        activeLeases.set(lease.id, { lease, hash, orgId: claims.org_id });
        return lease;
      },
      assertActive: validate,
      async allow(lease, direction, message) {
        if (!("method" in message)) return true;
        const method = message.method;
        if (method.startsWith("resources/")) {
          await validate(lease, "resources");
          return true;
        }
        if (method.startsWith("prompts/")) {
          await validate(lease, "prompts");
          return true;
        }
        if (method.startsWith("tools/")) {
          await validate(lease, "tools");
          return true;
        }
        return (
          [
            "initialize",
            "ping",
            "notifications/initialized",
            "notifications/cancelled",
            "notifications/progress",
            "notifications/tools/list_changed",
            "notifications/resources/list_changed",
            "notifications/resources/updated",
            "notifications/prompts/list_changed",
          ].includes(method) &&
          (direction === "upstream" || method !== "initialize")
        );
      },
      async upstreamHeaders(lease) {
        await validate(lease);
        const bound = (
          await sql.query<{ auth_type: string; value_enc: Uint8Array<ArrayBuffer> | null; generation: number }>(
            `select c.auth_type,g.value_enc,g.generation from public.mcp_leases l
          join public.mcp_connections c on c.id=l.connection_id join public.mcp_grants g on g.id=l.grant_id
          join public.sandboxes s on s.id=l.sandbox_id
          where l.id=$1::uuid and l.hash=$2 and l.generation=g.generation and l.sandbox_generation=s.mcp_generation
          and l.revoked_at is null and l.expires_at>now() and g.revoked_at is null and g.status='connected' and not c.disabled
          and c.url=$3 and c.transport=$4`,
            [lease.id, hashes.get(lease), lease.url, lease.transport],
          )
        ).rows[0];
        if (!bound) throw new GatewayError("denied", "Connection generation changed before upstream authentication.");
        const c = bound;
        const headers = new Headers();
        if (c.auth_type === "oauth") {
          // Refresh/read must stay on the lease's generation too: never pick up a new
          // human identity or send a replacement credential to an old session's URL.
          const scoped = createOAuthBroker({
            store: {
              ...store,
              readGrant: async (id) => {
                const grant = await store.readGrant(id);
                if (grant && grant.generation !== String(c.generation))
                  throw new GatewayError("denied", "Grant generation changed.");
                return grant;
              },
            },
            vault,
            redirectUri,
            development: options.development === true,
            clientMetadataUrl,
            fetch: oauthFetch,
            authorize: async () => validate(lease),
          });
          headers.set("authorization", `Bearer ${await scoped.access(lease.actorId, lease.connectionId, lease.url)}`);
        } else if (c.auth_type === "bearer" || c.auth_type === "headers") {
          if (!c.value_enc) throw new GatewayError("needs_reconnect", "Configure authentication.");
          const value = await decryptSecret(c.value_enc, options.encryptionKey);
          if (c.auth_type === "bearer") headers.set("authorization", `Bearer ${value}`);
          else for (const [key, header] of Object.entries(JSON.parse(value))) headers.set(key, String(header));
        } else if (c.auth_type !== "none")
          throw new GatewayError("needs_reconnect", "Discover and connect this endpoint first.");
        return vettedHeaders(headers);
      },
    },
  });
  async function refreshActiveExpiries(sandboxId?: string) {
    for (const [id, entry] of activeLeases) {
      if (sandboxId && entry.lease.sandboxId !== sandboxId) continue;
      if (!(await leases.validate(entry.hash, "tools"))) {
        await gateway.invalidateLease(id);
        activeLeases.delete(id);
        continue;
      }
      const current = (
        await sql.query<{ expires_at: Date }>("select expires_at from public.mcp_leases where id=$1::uuid", [id])
      ).rows[0];
      if (current) entry.lease.expiresAt = new Date(current.expires_at).getTime();
    }
  }
  const renewalDue = new Map<string, number>();
  let renewing: Promise<void> | undefined;
  function renewActiveLeases(): Promise<void> {
    if (renewing) return renewing;
    const work = async () => {
      if (!options.providerForSandbox) return;
      for (const entry of activeLeases.values()) {
        const id = entry.lease.sandboxId;
        if (entry.lease.expiresAt > Date.now() + 300000 || (renewalDue.get(id) ?? 0) > Date.now()) continue;
        const configured = (
          await sql.query<{ configured: boolean }>(
            "select configured from public.mcp_bootstraps where sandbox_id=$1::uuid",
            [id],
          )
        ).rows[0]?.configured;
        if (!configured) continue;
        renewalDue.set(id, Date.now() + 60000);
        try {
          const provider = await options.providerForSandbox(id);
          await lifecycle.renewLeases(provider, id);
        } catch {
          /* Do not extend on unknown physical state; other sandboxes remain unaffected. */
        }
        await refreshActiveExpiries(id);
      }
    };
    renewing = work().finally(() => {
      renewing = undefined;
    });
    return renewing;
  }
  let draining: Promise<void> | undefined;
  function drainInvalidations(): Promise<void> {
    if (draining) return draining;
    const work = async () => {
      for (const entry of activeLeases.values())
        if (entry.lease.expiresAt <= Date.now()) await refreshActiveExpiries(entry.lease.sandboxId);
      for (;;) {
        const events = await invalidations.pending(replica);
        if (!events.length) return;
        for (const event of events)
          for (const [id, entry] of activeLeases) {
            if (
              event.connectionId
                ? entry.lease.connectionId !== event.connectionId
                : event.sandboxId
                  ? entry.lease.sandboxId !== event.sandboxId
                  : entry.orgId !== event.orgId
            )
              continue;
            // Close only fenced leases. A delayed historical event must not cancel a new
            // generation's streams or another sandbox's active parallel conversation.
            if (!(await leases.validate(entry.hash, "tools"))) {
              await gateway.invalidateLease(id);
              activeLeases.delete(id);
            }
          }
        await invalidations.acknowledge(
          replica,
          events.map((e) => e.id),
        );
      }
    };
    draining = work().finally(() => {
      draining = undefined;
    });
    return draining;
  }
  const timer = setInterval(() => {
    // Provider expiry I/O must never delay durable revoke/disable stream closure.
    void drainInvalidations().catch(() => gateway.close());
    void renewActiveLeases().catch(() => gateway.close());
  }, 250);
  timer.unref();
  return {
    registry,
    broker,
    controlBroker: {
      async callback(actorId: string, state: string, code: string, issuer?: string) {
        const connection = await completeCallback(actorId, state, code, issuer);
        return { orgId: connection.orgId, connectionId: connection.id, status: connection.status };
      },
      async connect(input: { userId: string; orgId: string; connectionId: string }) {
        const result = await connectConnection(input.userId, input.orgId, input.connectionId);
        return {
          status: result.connection.status,
          ...("authorizationUrl" in result && result.authorizationUrl
            ? { authorizationUrl: result.authorizationUrl }
            : {}),
        };
      },
      async status(input: { userId: string; orgId: string; connectionId: string }) {
        return { status: (await connectionStatus(input.userId, input.orgId, input.connectionId)).status };
      },
    },
    connections: {
      ...lifecycle.connections,
      prepare: async (...args: Parameters<NonNullable<typeof lifecycle.connections.prepare>>) => {
        await lifecycle.connections.prepare?.(...args);
        await refreshActiveExpiries(args[1].id);
      },
    },
    beforeResume: async (...args: Parameters<typeof lifecycle.beforeResume>) => {
      const result = await lifecycle.beforeResume(...args);
      await refreshActiveExpiries(result.sandboxId);
      await drainInvalidations();
      return result.shouldResume;
    },
    beforePrompt: async (...args: Parameters<typeof lifecycle.beforePrompt>) => {
      const sandboxId = await lifecycle.beforePrompt(...args);
      await refreshActiveExpiries(sandboxId);
    },
    beforeSnapshot: async (...args: Parameters<typeof lifecycle.beforeSnapshot>) => {
      await lifecycle.beforeSnapshot(...args);
      await drainInvalidations();
    },
    reconcileSandbox: async (...args: Parameters<typeof lifecycle.reconcile>) => {
      await lifecycle.reconcile(...args);
      await refreshActiveExpiries(args[1].id);
    },
    drainInvalidations,
    renewActiveLeases,
    async close() {
      clearInterval(timer);
      await Promise.allSettled([draining, renewing]);
      await gateway.close();
      activeLeases.clear();
      renewalDue.clear();
    },
    async route(request: Request): Promise<Response | null> {
      const githubResponse = await githubRuntime?.route(request);
      if (githubResponse) return githubResponse;
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/armada-mcp-client.json") {
        // Bun sees HTTP behind TLS termination; keep the strict CIMD handler bound to
        // the configured HTTPS identity, never a forwarded or caller-selected origin.
        const host = request.headers.get("host");
        const canonical = !host || host === publicAddress.host ? gatewayIngress(request) : null;
        return canonical ? metadata(canonical) : new Response(null, { status: 404 });
      }
      if (path.startsWith("/mcp/gateway/")) {
        const canonical = gatewayIngress(request);
        if (!canonical) return new Response(null, { status: 403 });
        // Keep URL/browser-origin rejection ahead of an anonymous bearer challenge.
        if (
          new URL(canonical.url).origin !== origin ||
          (canonical.headers.has("origin") && canonical.headers.get("origin") !== origin)
        )
          return gateway.handle(canonical);
        if (!bearerToken(canonical.headers.get("authorization")))
          return Response.json(
            { code: "denied", action: "A scoped gateway bearer is required." },
            {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="armada-mcp-gateway"', "cache-control": "no-store" },
            },
          );
        return gateway.handle(canonical);
      }
      const prefix = "/api/v1/mcp/";
      if (!path.startsWith(prefix)) return null;
      const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
      try {
        if (request.method !== "POST") return new Response(null, { status: 405, headers });
        if (Number(request.headers.get("content-length") ?? 0) > 131072)
          return new Response(null, { status: 413, headers });
        const text = await request.text();
        if (text.length > 131072) return new Response(null, { status: 413, headers });
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
        const body = parsed as Record<string, unknown>;
        const auth = await authenticateCaller(request.headers.get("authorization"), {
          store: options.authStore,
          supabase: options.supabase,
          now: new Date(),
        });
        if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers });
        const actor = auth.caller;
        const action = path.slice(prefix.length);
        if (action === "oauth/callback") {
          if (actor.via !== "supabase")
            return Response.json(
              { error: "forbidden", message: "A signed-in browser session is required." },
              { status: 403, headers },
            );
          if (
            actor.via !== "supabase" ||
            typeof body.state !== "string" ||
            typeof body.code !== "string" ||
            body.state.length > 1024 ||
            body.code.length > 8192 ||
            (body.issuer !== undefined && typeof body.issuer !== "string")
          )
            throw new Error("Invalid callback");
          const connection = await completeCallback(
            actor.userId,
            body.state,
            body.code,
            typeof body.issuer === "string" ? body.issuer : undefined,
            request.signal,
          );
          return Response.json({ connection }, { headers });
        }
        if (body.org !== undefined && typeof body.org !== "string") throw new Error("Organization UUID required");
        const org =
          typeof body.org === "string"
            ? body.org.trim().toLowerCase()
            : actor.via !== "supabase"
              ? actor.orgs[0]?.orgId
              : undefined;
        if (!org || !actor.orgs.some((o) => o.orgId === org))
          throw new GatewayError("denied", "This request is not scoped to that organization.");
        const id = String(body.id ?? body.connectionId ?? "");
        if (action === "catalog") return Response.json({ services: await registry.catalog() }, { headers });
        if (action === "metadata")
          return Response.json({ connection: await registry.metadata(actor.userId, org, id, body) }, { headers });
        if (action === "list")
          return Response.json({ connections: await registry.list(actor.userId, org) }, { headers });
        if (action === "create" || action === "update") {
          if (body.transport === "stdio")
            parsePinnedMcpStdio(
              typeof body.command === "string" ? body.command : "",
              Array.isArray(body.args) ? (body.args as string[]) : [],
            );
          return Response.json(
            {
              connection: await registry.save(
                actor.userId,
                org,
                body as unknown as McpConnectionInput,
                action === "update" ? id : undefined,
              ),
            },
            { headers },
          );
        }
        if (action === "sandbox-connections")
          return Response.json({ connections: await registry.sandboxConnections(actor.userId, org, id) }, { headers });
        await registry.get(actor.userId, org, id);
        if (action === "revoke" || action === "delete") {
          await registry.revoke(actor.userId, org, id, action === "delete");
          return Response.json({ ok: true }, { headers });
        }
        if (action === "set-enabled") {
          if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json(
            { connection: await registry.setEnabled(actor.userId, org, id, body.enabled) },
            { headers },
          );
        }
        if (action === "status")
          return Response.json(
            { connection: await connectionStatus(actor.userId, org, id, request.signal) },
            { headers },
          );
        if (action === "connect" || action === "reconnect") {
          return Response.json(await connectConnection(actor.userId, org, id, request.signal), { headers });
        }
        return Response.json({ error: "not_found" }, { status: 404, headers });
      } catch (error) {
        const status =
          error instanceof AuthUnavailable
            ? 503
            : error instanceof GatewayError
              ? error.code === "denied"
                ? 403
                : error.code === "busy"
                  ? 409
                  : error.code === "upstream"
                    ? 502
                    : 400
              : error instanceof VaultError
                ? error.code === "forbidden"
                  ? 403
                  : error.code === "not_found"
                    ? 404
                    : error.code === "unavailable"
                      ? 503
                      : 400
                : 400;
        return Response.json(
          {
            error:
              error instanceof GatewayError
                ? error.code
                : error instanceof VaultError
                  ? error.code
                  : error instanceof AuthUnavailable
                    ? "temporarily_unavailable"
                    : "invalid_request",
            message:
              error instanceof GatewayError
                ? error.action
                : error instanceof McpStdioError
                  ? error.message
                  : "MCP request denied; verify membership and connection state.",
          },
          { status, headers },
        );
      }
    },
  };
}
