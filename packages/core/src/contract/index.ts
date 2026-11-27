import { z } from "zod";
import { accountOperations, antigravityLoginOperations } from "./accounts.ts";
import type { ServerFailureCode } from "./failures.ts";
import { githubReposOperation } from "./github-repos.ts";
import { createdInboundTrigger, createInboundTriggerBody, createInboundTriggerQuery } from "./inbound-trigger.ts";
import { launchInput } from "./launch.ts";
import { launchResponse } from "./launch-response.ts";
import { memberOperations } from "./members.ts";
import { organizationOperations } from "./organizations.ts";
import { githubCallbackOperations, publicAuthOperations } from "./public-auth.ts";
import { githubOperations, goldenOperations, launchTemplateOperation } from "./resources.ts";
import { sandboxOperations } from "./sandbox.ts";
import { sandboxCheckOperations } from "./sandbox-checks.ts";
import { streamSandboxEvents } from "./sandbox-events.ts";
import { sandboxOutputOperations } from "./sandbox-outputs.ts";
import { launchOptionsOperation, readLogsOperation } from "./sandbox-reads.ts";
import { sandboxRelayOperations } from "./sandbox-relay.ts";
import { sandboxRestOperations } from "./sandbox-rest.ts";
import { sandboxViewerOperations } from "./sandbox-viewer.ts";
import { scopedRestOperations } from "./scoped.ts";
import { skillDefaultOperations } from "./skill-defaults.ts";
import { skillpackOperations } from "./skillpack.ts";
import { tokenOperations } from "./tokens.ts";

export {
  accountOperations,
  antigravityLoginOperations,
  antigravityLoginPath,
  isAntigravityLoginPath,
} from "./accounts.ts";
export {
  DOCKER_HOST_UPDATE_HEALTH_HEADER,
  DOCKER_HOST_UPDATE_RESULT_HEADER,
  type DockerHostUpdatePolicy,
  type DockerHostUpdateResult,
  type DockerHostVersionStatus,
  dockerHostReleasePattern,
  isDockerHostUpdatePolicy,
  isDockerHostUpdateResult,
  isDockerHostVersionStatus,
  parseDockerHostUpdateReport,
} from "./docker-host.ts";
export {
  type GitHubReposRequest,
  type GitHubReposResponse,
  githubReposOperation,
  githubReposRequest,
  githubReposResponse,
} from "./github-repos.ts";
export type { CreatedInboundTrigger } from "./inbound-trigger.ts";
export {
  type DockerLaunchInput,
  dockerHostLaunchFields,
  dockerSnapshotLaunchFields,
  type GoldenLaunchInput,
  type LaunchInput,
  type PinnedModalLaunchInput,
} from "./launch.ts";
export {
  type LaunchEnvelope,
  launchEnvelope,
  type ModalLaunchReceipt,
  modalLaunchReceipt,
  type PinnedModalLaunchReceipt,
  parseLaunchAdmissionReceipt,
  pinnedModalLaunchReceipt,
  templateLaunchResponse,
} from "./launch-response.ts";
export { memberOperations } from "./members.ts";
export { ORG_PROVIDER_CREDENTIAL_MAX_LENGTH, organizationOperations, orgProvider } from "./organizations.ts";
export {
  deviceConsentMessage,
  githubCallbackOperations,
  PUBLIC_CONTROL_ROUTES,
  publicAuthOperations,
} from "./public-auth.ts";
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
export * from "./sandbox-relay.ts";
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
export { serviceTokenExpiry, tokenOperations } from "./tokens.ts";

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
    "Launches from a Boat or Modal golden. Returns a sandbox ID and starting status as soon as admitted. " +
    "The worker prepares the sandbox and starts the optional first prompt after enrolment. " +
    "Personal sessions may use an org slug or UUID. For scoped tokens, omit `org` or use the scoped org UUID.",
  route: { method: "POST", path: "/api/v1/sandbox/launch" },
  input: { body: launchInput },
  output: launchResponse,
  readOnly: false,
  destructive: false,
  audience: "agent",
  description: "Launch a sandbox and optionally start its first turn.",
  errors: ["invalid"],
} as const satisfies Operation<typeof launchInput, typeof launchResponse>;

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
  listGitHubRepos: githubReposOperation,
  ...tokenOperations,
  ...accountOperations,
  ...antigravityLoginOperations,
  ...memberOperations,
  ...organizationOperations,
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
  mintSandboxRelayTicket: sandboxRelayOperations.mintTicket,
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

export type TemplateLaunchInput = z.input<typeof operations.launchTemplate.input.body>;
export type TemplateLaunchResult = z.infer<typeof operations.launchTemplate.output>;
export type SendInput = z.input<typeof operations.sendPrompt.input.body>;
export type SendResult = z.infer<typeof operations.sendPrompt.output>;
export type StatusInput = z.input<typeof operations.sandboxStatus.input.body>;
export type SandboxStatus = z.infer<typeof operations.sandboxStatus.output>;
export type WaitInput = z.input<typeof operations.waitSandbox.input.body>;
export type WaitResult = z.infer<typeof operations.waitSandbox.output>;
export type StopInput = z.input<typeof operations.stopSandbox.input.body>;
export type StopResult = z.infer<typeof operations.stopSandbox.output>;
export type LogsInput = z.infer<typeof operations.readLogs.input.body>;
export type LogsResult = z.infer<typeof operations.readLogs.output>;
export type ListInput = z.input<typeof operations.listSandboxes.input.body>;
export type ListResult = z.infer<typeof operations.listSandboxes.output>;
export type InterruptInput = z.input<typeof operations.interruptSandbox.input.body>;
export type InterruptResult = z.infer<typeof operations.interruptSandbox.output>;
export type SteerInput = z.input<typeof operations.steerSandbox.input.body>;
export type SteerResult = z.infer<typeof operations.steerSandbox.output>;
export type ExecInput = z.input<typeof operations.execSandbox.input.body>;
export type ExecResult = z.infer<typeof operations.execSandbox.output>;
export type ViewerTokenInput = z.input<typeof operations.createSandboxViewerToken.input.body>;
export type ViewerTokenResult = z.infer<typeof operations.createSandboxViewerToken.output>;
export type OutputsListInput = { id: z.input<typeof sandboxOutputOperations.listSandboxOutputs.input.path.id> };
export type OutputsListResult = z.infer<typeof sandboxOutputOperations.listSandboxOutputs.output>;
type OutputDownload = typeof sandboxOutputOperations.readSandboxOutput;
export type OutputGetInput = {
  id: z.input<OutputDownload["input"]["path"]["id"]>;
  name: z.input<OutputDownload["input"]["path"]["name"]>;
  range?: z.input<OutputDownload["input"]["headers"]["Range"]>;
  ifRange?: z.input<OutputDownload["input"]["headers"]["If-Range"]>;
};

type SdkOperationName =
  | "launch"
  | "launchTemplate"
  | "sendPrompt"
  | "sandboxStatus"
  | "waitSandbox"
  | "stopSandbox"
  | "readLogs"
  | "execSandbox"
  | "listSandboxes"
  | "interruptSandbox"
  | "steerSandbox"
  | "createSandboxViewerToken";
type UnmappedSdkError = Exclude<(typeof operations)[SdkOperationName]["errors"][number], ServerFailureCode>;
const sdkErrorsCovered: UnmappedSdkError extends never ? true : never = true;
void sdkErrorsCovered;
