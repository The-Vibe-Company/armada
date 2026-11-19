import type { z } from "zod";
import { createdInboundTrigger, createInboundTriggerBody, createInboundTriggerQuery } from "./inbound-trigger.ts";
import { launchInput } from "./launch.ts";
import { launchEnvelope } from "./launch-response.ts";
import { githubOperations, goldenOperations, launchTemplateOperation } from "./resources.ts";
import { sandboxOperations } from "./sandbox.ts";
import { sandboxCheckOperations } from "./sandbox-checks.ts";
import { sandboxOutputOperations } from "./sandbox-outputs.ts";
import { launchOptionsOperation, readLogsOperation } from "./sandbox-reads.ts";
import { sandboxRestOperations } from "./sandbox-rest.ts";
import { sandboxViewerOperations } from "./sandbox-viewer.ts";

export type { CreatedInboundTrigger } from "./inbound-trigger.ts";
export {
  dockerHostLaunchFields,
  dockerSnapshotLaunchFields,
  type LaunchInput,
  type PinnedModalLaunchInput,
} from "./launch.ts";
export { type LaunchEnvelope, launchEnvelope, templateLaunchResponse } from "./launch-response.ts";
export { githubOperations, goldenOperations, launchTemplateOperation } from "./resources.ts";
export {
  DEFAULT_WAIT_SECONDS,
  LOGS_OUTPUT,
  MAX_WAIT_SECONDS,
  SANDBOX_STATUSES,
  sandboxIdInput,
  sandboxOperations,
} from "./sandbox.ts";

export function controlRouteKey<Path extends string>(route: { readonly path: `/api/v1/${Path}` }) {
  return route.path.slice("/api/v1/".length) as Path;
}

export { sandboxCheckOperations } from "./sandbox-checks.ts";
export { sandboxOutputOperations } from "./sandbox-outputs.ts";
export { launchOptionsOperation, MAX_LOG_PAGES, readLogsOperation } from "./sandbox-reads.ts";
export { sandboxExtensionLifetime, sandboxRestOperations } from "./sandbox-rest.ts";
export { sandboxViewerOperations, VIEWER_ACCESS_DENIED } from "./sandbox-viewer.ts";

export interface Operation<Input extends z.ZodType, Output extends z.ZodType | undefined = undefined> {
  readonly name: string;
  readonly toolName?: string;
  readonly mcpDescription?: string;
  readonly route: { readonly method: string; readonly path: `/api/v1/${string}` };
  readonly input: {
    readonly body: Input;
    readonly maxBodyBytes?: number;
    readonly query?: z.ZodType;
    readonly path?: Readonly<Record<string, z.ZodType>>;
    readonly headers?: Readonly<Record<string, z.ZodType>>;
  };
  readonly output: Output;
  readonly directServer?: true;
  readonly outputMediaType?: string;
  readonly errorOutput?: z.ZodType;
  readonly successStatus?: number;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly audience: "public" | "agent" | "admin";
  readonly description: string;
  readonly errors: readonly string[];
}

export const launch = {
  name: "launch",
  toolName: "launch",
  mcpDescription:
    "Forks a golden into a new sandbox, pulls its repos, runs its init commands, and starts the agent. " +
    "With `prompt` the agent starts working at once (status running). Without it the sandbox is left ready " +
    "and the conversation starts at the first `send`. The sandbox gets only your (or your org's) Armada " +
    "credentials for this agent, never the boat.dev account's. When the caller connected GitHub, git and gh in " +
    "the sandbox act as that person (8 hour token): see `github` in the answer. Setup can take a few minutes. " +
    "Personal sessions may use an org slug or UUID. For scoped tokens, omit `org` or use the scoped org UUID.",
  route: { method: "POST", path: "/api/v1/sandbox/launch" },
  input: { body: launchInput },
  output: launchEnvelope,
  readOnly: false,
  destructive: false,
  audience: "agent",
  description: "Launch a sandbox and optionally start its first turn.",
  errors: ["invalid"],
} as const satisfies Operation<typeof launchInput, typeof launchEnvelope>;

export const createInboundTrigger = {
  name: "createInboundTrigger",
  route: { method: "POST", path: "/api/v1/triggers" },
  input: { body: createInboundTriggerBody, query: createInboundTriggerQuery },
  output: createdInboundTrigger,
  successStatus: 201,
  readOnly: false,
  destructive: false,
  audience: "admin",
  description: "Create an inbound trigger in the selected organization and return its signing key once.",
  errors: ["invalid_request", "unauthorized", "forbidden", "conflict", "dependency_unavailable"],
} as const satisfies Operation<typeof createInboundTriggerBody, typeof createdInboundTrigger>;

export const operations = {
  launch,
  ...goldenOperations,
  ...githubOperations,
  launchTemplate: launchTemplateOperation,
  createInboundTrigger,
  ...sandboxOperations,
  ...sandboxRestOperations,
  ...sandboxCheckOperations,
  ...sandboxOutputOperations,
  launchOptions: launchOptionsOperation,
  readLogs: readLogsOperation,
  createSandboxViewerToken: sandboxViewerOperations.mint,
  readViewerLogs: sandboxViewerOperations.logs,
  readViewerStatus: sandboxViewerOperations.status,
  sendViewerPrompt: sandboxViewerOperations.send,
  streamViewerEvents: sandboxViewerOperations.events,
} as const;
