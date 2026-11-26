import {
  listOrgs,
  type McpBrokerPort,
  type McpConnectionDto,
  type McpConnectionInput,
  type McpRegistry,
  parsePinnedMcpStdio,
  VaultError,
  type VaultStore,
} from "@armada/core/server";
import { scopedOrg } from "./control-caller.ts";
import { optional, required, UUID } from "./control-input.ts";

import { type ControlRouteContext, defineRoutes } from "./routes.ts";

type ProbeMetadata = {
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  lastError?: string;
};

export interface McpControlBroker extends McpBrokerPort {
  callback?(
    actorId: string,
    state: string,
    code: string,
    issuer?: string,
    signal?: AbortSignal,
  ): Promise<{ orgId: string; connectionId: string; status: McpConnectionDto["status"] } & ProbeMetadata>;
  connect(input: {
    userId: string;
    orgId: string;
    connectionId: string;
    signal?: AbortSignal;
  }): Promise<{ status: McpConnectionDto["status"]; authorizationUrl?: string } & ProbeMetadata>;
  status(input: {
    userId: string;
    orgId: string;
    connectionId: string;
    signal?: AbortSignal;
  }): Promise<{ status: McpConnectionDto["status"]; toolNames?: string[] } & ProbeMetadata>;
}

export interface McpControlOptions {
  store: VaultStore;
  mcp?: { registry: McpRegistry; broker?: McpControlBroker };
}

function probeMetadata(result: ProbeMetadata) {
  return {
    ...(result.toolCount !== undefined ? { toolCount: result.toolCount } : {}),
    ...(result.resourceCount !== undefined ? { resourceCount: result.resourceCount } : {}),
    ...(result.promptCount !== undefined ? { promptCount: result.promptCount } : {}),
    ...(result.lastError !== undefined ? { lastError: result.lastError } : {}),
  };
}

export async function dispatchMcp(
  action: string,
  userId: string,
  body: Record<string, unknown>,
  options: McpControlOptions,
  signal?: AbortSignal,
) {
  if (action === "oauth/callback") {
    const callback = options.mcp?.broker?.callback;
    if (!callback || !options.mcp) throw new VaultError("unavailable", "MCP OAuth callback broker is not configured.");
    const state = required(body, "state");
    const code = required(body, "code");
    if (state.length > 1024 || code.length > 8192) throw new VaultError("invalid", "Invalid OAuth callback payload.");
    const result = await callback.call(options.mcp.broker, userId, state, code, optional(body, "issuer"), signal);
    const connection = await options.mcp.registry.get(userId, result.orgId, result.connectionId);
    return {
      connection: {
        ...connection,
        ...probeMetadata(result),
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
    if (action === "connect") {
      try {
        parsePinnedMcpStdio(connection.command ?? "", connection.args ?? []);
      } catch (error) {
        throw new VaultError("invalid", error instanceof Error ? error.message : "Invalid pinned stdio MCP launcher.");
      }
      return {
        connection: connection.status === "connected" ? connection : await registry.configureStdio(userId, orgId, id),
      };
    }
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
    const result = await broker[action]({ userId, orgId, connectionId: id, ...(signal ? { signal } : {}) });
    const current = await registry.get(userId, orgId, id);
    return {
      connection: {
        ...current,
        ...probeMetadata(result),
        status: current.status === "disabled" || result.status === "connected" ? current.status : result.status,
      },
      ...("authorizationUrl" in result && result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
    };
  }
  throw new VaultError("not_found", "Unknown MCP control action.");
}

async function mcpCommand({ route, caller, body, options, request }: ControlRouteContext) {
  const org = scopedOrg(caller, optional(body, "org"));
  if (route === "mcp/sandbox-connections") {
    const id = required(body, "id");
    if (!UUID.test(id)) throw new VaultError("invalid", "id must be a sandbox UUID.");
    if (options.data) {
      const sandbox = await options.data(caller).sandboxes.get(id);
      if (!sandbox || sandbox.orgId !== org) throw new VaultError("not_found", "No such sandbox.");
    }
  }
  return dispatchMcp(route.slice(4), caller.userId, { ...body, org }, options, request?.signal);
}

export const mcpRoutes = defineRoutes("mcp", {
  "mcp/catalog": mcpCommand,
  "mcp/metadata": mcpCommand,
  "mcp/list": mcpCommand,
  "mcp/create": mcpCommand,
  "mcp/update": mcpCommand,
  "mcp/sandbox-connections": mcpCommand,
  "mcp/set-enabled": mcpCommand,
  "mcp/delete": mcpCommand,
  "mcp/revoke": mcpCommand,
  "mcp/connect": mcpCommand,
  "mcp/status": mcpCommand,
  "mcp/oauth/callback": ({ caller, body, options, request }) => {
    if (caller.via !== "supabase")
      throw new VaultError("forbidden", "OAuth callbacks require a personal sign-in session.");
    return dispatchMcp("oauth/callback", caller.userId, body, options, request?.signal);
  },
});
