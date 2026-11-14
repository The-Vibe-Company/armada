import {
  listOrgs,
  type McpBrokerPort,
  type McpConnectionInput,
  type McpRegistry,
  VaultError,
  type VaultStore,
} from "@armada/core/server";
import { optional, required, UUID } from "./control-input.ts";

export interface McpControlOptions {
  store: VaultStore;
  mcp?: { registry: McpRegistry; broker?: McpBrokerPort };
}

export async function dispatchMcp(
  action: string,
  userId: string,
  body: Record<string, unknown>,
  options: McpControlOptions,
) {
  if (action === "oauth/callback") {
    const callback = options.mcp?.broker?.callback;
    if (!callback || !options.mcp) throw new VaultError("unavailable", "MCP OAuth callback broker is not configured.");
    const result = await callback.call(
      options.mcp.broker,
      userId,
      required(body, "state"),
      required(body, "code"),
      optional(body, "issuer"),
    );
    const connection = await options.mcp.registry.get(userId, result.orgId, result.connectionId);
    return {
      connection: {
        ...connection,
        status: connection.status === "disabled" || result.status === "connected" ? connection.status : result.status,
      },
    };
  }
  const orgId = required(body, "org");
  if (!UUID.test(orgId)) throw new VaultError("invalid", "org must be an organization UUID.");
  // Membership checked even if the registry is not configured.
  const orgs = await listOrgs(options.store, userId);
  if (!orgs.some((o) => o.id === orgId)) throw new VaultError("forbidden", "Organization membership required.");
  if (!options.mcp) throw new VaultError("unavailable", "MCP registry is not configured on this server.");
  const { registry, broker } = options.mcp;
  if (action === "catalog") return { services: await registry.catalog() };
  if (action === "metadata") {
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be a connection UUID.");
    return { connection: await registry.metadata(userId, orgId, id, body) };
  }
  if (action === "list") return { connections: await registry.list(userId, orgId) };
  if (action === "create" || action === "update") {
    if (action === "update" && !UUID.test(required(body, "id")))
      throw new VaultError("invalid", "id must be a connection UUID.");
    return {
      connection: await registry.save(
        userId,
        orgId,
        body as unknown as McpConnectionInput,
        action === "update" ? required(body, "id") : undefined,
      ),
    };
  }
  const id = required(body, "id");
  if (!UUID.test(id)) throw new VaultError("invalid", "id must be a connection UUID.");
  if (action === "sandbox-connections") return { connections: await registry.sandboxConnections(userId, orgId, id) };
  if (action === "set-enabled") {
    if (typeof body.enabled !== "boolean") throw new VaultError("invalid", "enabled must be a boolean.");
    return { connection: await registry.setEnabled(userId, orgId, id, body.enabled) };
  }
  const connection = await registry.get(userId, orgId, id);
  if (action === "delete" || action === "revoke") {
    await registry.revoke(userId, orgId, id, action === "delete");
    return { ok: true };
  }
  if (action === "connect" && connection.scope === "org" && !orgs.some((o) => o.id === orgId && o.role === "admin"))
    throw new VaultError("forbidden", "Only an organization administrator may connect a shared grant.");
  if (action === "connect" && connection.status === "disabled")
    throw new VaultError("conflict", "Enable this MCP connection before connecting.");
  if (connection.transport === "stdio") {
    if (action === "connect") return { connection: await registry.configureStdio(userId, orgId, id) };
    if (action === "status") return { connection };
  }
  if (action === "status" && connection.status === "disabled") return { connection };
  if (action === "connect" || action === "status") {
    if (!broker)
      return {
        connection: {
          ...connection,
          status: "unavailable",
          lastError: "MCP broker is not configured. Ask your administrator to configure the OAuth/gateway service.",
        },
      };
    const result = await broker[action]({ userId, orgId, connectionId: id });
    const current = await registry.get(userId, orgId, id);
    return {
      connection: {
        ...current,
        status: current.status === "disabled" || result.status === "connected" ? current.status : result.status,
      },
      ...("authorizationUrl" in result && result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
    };
  }
  throw new VaultError("not_found", "Unknown MCP control action.");
}
