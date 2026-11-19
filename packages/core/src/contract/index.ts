import type { z } from "zod";
import { createdInboundTrigger, createInboundTriggerBody, createInboundTriggerQuery } from "./inbound-trigger.ts";
import { launchInput } from "./launch.ts";
import { launchOutput } from "./launch-response.ts";
import { sandboxOperations } from "./sandbox.ts";
import { sandboxCheckOperations } from "./sandbox-checks.ts";
import { sandboxOutputOperations } from "./sandbox-outputs.ts";
import { launchOptionsOperation, readLogsOperation } from "./sandbox-reads.ts";
import { sandboxRestOperations } from "./sandbox-rest.ts";
import { sandboxViewerOperations } from "./sandbox-viewer.ts";

export type { CreatedInboundTrigger } from "./inbound-trigger.ts";
export type { LaunchInput } from "./launch.ts";
export { type LaunchEnvelope, launchEnvelope, templateLaunchResponse } from "./launch-response.ts";
export {
  DEFAULT_WAIT_SECONDS,
  LOGS_OUTPUT,
  MAX_WAIT_SECONDS,
  SANDBOX_STATUSES,
  sandboxIdInput,
  sandboxOperations,
} from "./sandbox.ts";

export { sandboxCheckOperations } from "./sandbox-checks.ts";
export { sandboxOutputOperations } from "./sandbox-outputs.ts";
export { launchOptionsOperation, MAX_LOG_PAGES, readLogsOperation } from "./sandbox-reads.ts";
export { sandboxExtensionLifetime, sandboxRestOperations } from "./sandbox-rest.ts";
export { sandboxViewerOperations, VIEWER_ACCESS_DENIED } from "./sandbox-viewer.ts";

export interface Operation<Input extends z.ZodType, Output extends z.ZodType | undefined = undefined> {
  readonly name: string;
  readonly toolName?: string;
  readonly route: { readonly method: string; readonly path: `/api/v1/${string}` };
  readonly input: {
    readonly body: Input;
    readonly query?: z.ZodType;
    readonly path?: Readonly<Record<string, z.ZodType>>;
    readonly headers?: Readonly<Record<string, z.ZodType>>;
  };
  readonly output: Output;
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
  route: { method: "POST", path: "/api/v1/sandbox/launch" },
  input: { body: launchInput },
  output: launchOutput,
  readOnly: false,
  destructive: false,
  audience: "agent",
  description: "Launch a sandbox and optionally start its first turn.",
  errors: ["invalid"],
} as const satisfies Operation<typeof launchInput, typeof launchOutput>;

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
