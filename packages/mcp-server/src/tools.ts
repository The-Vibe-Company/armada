import type {
  LaunchOptions,
  LaunchStores,
  Provider,
  ProviderTarget,
  SandboxProviderId,
  SkillDefaultsService,
} from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Caller } from "./caller.ts";
import type { ScopedData } from "./data.ts";
import type { GoldenLaunchCredentials } from "./launch-account-admission.ts";
import type { LaunchDiscoveryOptions } from "./launch-options.ts";
import { registerAgentTools } from "./mcp-operation-projection.ts";
import type { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import { configureTools } from "./sandbox-tool-handlers.ts";
import type { ToolBinding } from "./tool-registration.ts";

/** Everything a tool call may use, for one authenticated request. */
export interface ToolContext {
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
  sandboxBillingAccount?: (id: string) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  runtimeSend?: RuntimeFollowup;
  measure?: import("./request-timing.ts").RequestTiming["measure"];
  storedProviders?: Partial<Record<SandboxProviderId, ToolContext["provider"]>>;
  skillDefaults?: SkillDefaultsService;
  caller: Caller;
  data: ScopedData;
  /** The launch's credentials: the caller's own for the harness, else the golden's org's. Decrypted in this process. */
  launchCredentials: GoldenLaunchCredentials;
  /** The caller's own and one org's model credentials, decrypted, for redacting command output. */
  exposedSecrets(orgId: string): Promise<string[]>;
  /** A provider paying with the boat.dev key of a golden of this org and visibility. The key never leaves the server. */
  /** The provider of a golden's or a sandbox's own backend (see `ProviderRegistry`). Its key never leaves the server. */
  provider(target: ProviderTarget): Promise<Provider>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  launch?: LaunchOptions;
  ordinaryLaunchReceipts?: ReturnType<typeof createOrdinaryLaunchReceipts>;
  connections?: LaunchStores["connections"];
  /** Where the real cause of an internal or unavailable tool error goes, redacted. Defaults to stderr. */
  logError?: (line: string) => void;
}

export const serverInfo = { name: "armada" } as const;

/** One MCP server per request: the principal is fixed for its whole life, and nothing outlives the request. */
export function createArmadaServer(
  context: ToolContext,
  version: string,
  launchDiscovery: LaunchDiscoveryOptions = context,
) {
  const server = createToolServer(version);
  registerAgentTools(server, context, launchDiscovery);
  return server;
}

/** In-memory REST dispatch and schema discovery. Never exposed on the MCP transport. */
export function createRestToolServer(context: ToolContext, version: string, onlyTool?: "list") {
  const server = createToolServer(version);
  configureTools(context, "rest", server, onlyTool);
  return server;
}

function createToolServer(version: string) {
  const server = new McpServer(
    { ...serverInfo, version },
    {
      instructions:
        "Armada launches Claude Code, Codex and OpenCode agents in sandboxes. " +
        "Provider and agent availability depend on server configuration. In these tools, a golden is a snapshot. " +
        "Find a golden with the dashboard or POST /api/v1/golden/list. Then launch with a prompt, use status, and use logs to read " +
        "what the agent did, send for the next instruction, and stop when done. Ids are Armada sandbox ids.",
    },
  );
  return server;
}

export function bindRestTool(context: ToolContext, name: string, bind: ToolBinding) {
  configureTools(context, "rest", undefined, name === "list" ? "list" : undefined, (candidate, config, invoke) => {
    if (candidate === name) bind(candidate, config, invoke);
  });
}
