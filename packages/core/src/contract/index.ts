import { z } from "zod";
import { accountOperations } from "./accounts.ts";
import { createdInboundTrigger, createInboundTriggerBody, createInboundTriggerQuery } from "./inbound-trigger.ts";
import { launchInput } from "./launch.ts";
import { launchEnvelope } from "./launch-response.ts";
import { githubCallbackOperations, publicAuthOperations } from "./public-auth.ts";
import { githubOperations, goldenOperations, launchTemplateOperation } from "./resources.ts";
import { sandboxOperations } from "./sandbox.ts";
import { sandboxCheckOperations } from "./sandbox-checks.ts";
import { streamSandboxEvents } from "./sandbox-events.ts";
import { sandboxOutputOperations } from "./sandbox-outputs.ts";
import { launchOptionsOperation, readLogsOperation } from "./sandbox-reads.ts";
import { sandboxRestOperations } from "./sandbox-rest.ts";
import { sandboxViewerOperations } from "./sandbox-viewer.ts";
import { scopedRestOperations } from "./scoped.ts";
import { skillDefaultOperations } from "./skill-defaults.ts";
import { skillpackOperations } from "./skillpack.ts";
import { tokenOperations } from "./tokens.ts";

export { accountOperations } from "./accounts.ts";
export type { CreatedInboundTrigger } from "./inbound-trigger.ts";
export {
  dockerHostLaunchFields,
  dockerSnapshotLaunchFields,
  type LaunchInput,
  type PinnedModalLaunchInput,
} from "./launch.ts";
export { type LaunchEnvelope, launchEnvelope, templateLaunchResponse } from "./launch-response.ts";
export { githubCallbackOperations, PUBLIC_CONTROL_ROUTES, publicAuthOperations, signInMethod } from "./public-auth.ts";
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
export { streamSandboxEvents } from "./sandbox-events.ts";
export { MCP_OUTPUT_MAX_BYTES, sandboxOutputOperations } from "./sandbox-outputs.ts";
export { launchOptionsOperation, MAX_LOG_PAGES, readLogsOperation } from "./sandbox-reads.ts";
export { sandboxExtensionLifetime, sandboxRestOperations } from "./sandbox-rest.ts";
export { sandboxViewerOperations, VIEWER_ACCESS_DENIED } from "./sandbox-viewer.ts";

export {
  isScopedMethod,
  ORCHESTRATOR_SCOPED_PATH,
  SCOPED_REST_BODY_MAX_BYTES,
  type ScopedErrorCode,
  scopedOperations,
  scopedRestOperations,
} from "./scoped.ts";

export { skillDefaultOperations } from "./skill-defaults.ts";
export { skillpackOperations, skillpackVersionInputs } from "./skillpack.ts";
export { tokenOperations } from "./tokens.ts";

export interface Operation<Input extends z.ZodType, Output extends z.ZodType | undefined = undefined> {
  readonly name: string;
  readonly toolName?: string;
  readonly mcpDescription?: string;
  readonly route: { readonly method: string; readonly path: `/api/v1/${string}` };
  readonly input: {
    readonly body: Input;
    readonly bodyRequired?: false;
    readonly maxBodyBytes?: number;
    readonly oversizedBodyStatus?: 400;
    readonly query?: z.ZodType;
    readonly path?: Readonly<Record<string, z.ZodType>>;
    readonly headers?: Readonly<Record<string, z.ZodType>>;
  };
  readonly output: Output;
  readonly directServer?: true;
  readonly anonymous?: true;
  readonly scopedAuth?: readonly ("epochGrant" | "finishGrant" | "personalSession" | "serviceToken" | "viewerGrant")[];
  readonly successHeaders?: Readonly<Record<string, z.ZodType>>;
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
  directServer: true,
  input: {
    body: createInboundTriggerBody,
    query: createInboundTriggerQuery,
    maxBodyBytes: 4096,
    oversizedBodyStatus: 400,
  },
  output: createdInboundTrigger,
  successStatus: 201,
  successHeaders: { "Cache-Control": z.literal("no-store") },
  readOnly: false,
  destructive: false,
  audience: "admin",
  description: "Create an inbound trigger in the selected organization and return its signing key once.",
  errors: ["invalid_request", "unauthorized", "forbidden", "conflict", "dependency_unavailable"],
} as const satisfies Operation<typeof createInboundTriggerBody, typeof createdInboundTrigger>;

export const operations = {
  launch,
  ...publicAuthOperations,
  ...githubCallbackOperations,
  ...goldenOperations,
  ...githubOperations,
  ...tokenOperations,
  ...accountOperations,
  ...skillDefaultOperations,
  ...skillpackOperations,
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
  streamSandboxEvents,
  scopedFinish: scopedRestOperations.finish,
  scopedLaunch: scopedRestOperations.launch,
  scopedRead: scopedRestOperations.read,
  scopedMessage: scopedRestOperations.message,
  scopedStop: scopedRestOperations.stop,
  scopedExtend: scopedRestOperations.extend,
} as const;
