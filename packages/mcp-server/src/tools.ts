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
import type { SandboxView, ScopedData } from "./data.ts";
import type { GoldenLaunchCredentials } from "./launch-account-admission.ts";
import type { LaunchDiscoveryOptions } from "./launch-options.ts";
import { registerAgentTools } from "./mcp-operation-projection.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import type { createModalJobReader, SandboxLogReader } from "./runtime-history.ts";
import { configureTools } from "./sandbox-tool-handlers.ts";
import type { ToolBinding } from "./tool-registration.ts";

/** Everything a tool call may use, for one authenticated request. */
export interface ToolContext {
  readOutputSnapshot?: ReturnType<typeof import("./sandbox-outputs.ts").createSandboxOutputs>["readSnapshot"];
  outputSignal?: AbortSignal;
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
  sandboxBillingAccount?: (id: string) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  runtimeSend?: RuntimeFollowup;
  configureStopRequest?: () => void;
  stopSignal?: AbortSignal;
  runtimeStopCheckpoint?: ReturnType<typeof import("./runtime-checkpoint.ts").createRuntimeStopCheckpoint>;
  measure?: import("./request-timing.ts").RequestTiming["measure"];
  logProvider?(target: SandboxView): Promise<SandboxLogReader>;
  modalJobReader?: (target: SandboxView) => ReturnType<ReturnType<typeof createModalJobReader>>;
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
  admitModalLaunch?: import("./modal-launch-admission.ts").AdmitModalLaunch;
  connections?: LaunchStores["connections"];
  /** Where the real cause of an internal or unavailable tool error goes, redacted. Defaults to stderr. */
  logError?: (line: string) => void;
  onLocalToolError?: (error: unknown) => void;
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

function createToolServer(version: string) {
  const server = new McpServer(
    { ...serverInfo, version },
    {
      instructions:
        "Armada launches Claude Code, Codex, OpenCode and Antigravity agents in sandboxes. " +
        "Call launch_options to inspect configured providers, harnesses, models and machine sizes. In these tools, a golden is a snapshot. " +
        "Find a golden with the dashboard or POST /api/v1/golden/list. Then launch with a prompt, use list and status to track progress, " +
        "logs to read what the agent did, send for the next instruction (or steer a running turn), exec to run commands, " +
        "outputs_list and output_read for output files, report to record a finished outcome, and stop when done. Ids are Armada sandbox ids.",
    },
  );
  return server;
}

export function bindRestTool(context: ToolContext, name: string, bind: ToolBinding) {
  configureTools(context, "rest", name === "list" ? "list" : undefined, (candidate, config, invoke) => {
    if (candidate === name) bind(candidate, config, invoke);
  });
}
