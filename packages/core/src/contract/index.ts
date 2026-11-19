import type { z } from "zod";
import { createdInboundTrigger, createInboundTriggerBody, createInboundTriggerQuery } from "./inbound-trigger.ts";
import { launchInput } from "./launch.ts";
import { launchOutput } from "./launch-response.ts";

export type { CreatedInboundTrigger } from "./inbound-trigger.ts";
export type { LaunchInput } from "./launch.ts";
export { type LaunchEnvelope, launchEnvelope, templateLaunchResponse } from "./launch-response.ts";

export interface Operation<Input extends z.ZodType, Output extends z.ZodType | undefined = undefined> {
  readonly name: string;
  readonly route: { readonly method: string; readonly path: `/api/v1/${string}` };
  readonly input: { readonly body: Input; readonly query?: z.ZodType };
  readonly output: Output;
  readonly successStatus?: number;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly audience: "public" | "agent" | "admin";
  readonly description: string;
  readonly errors: readonly string[];
}

export const launch = {
  name: "launch",
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

export const operations = { launch, createInboundTrigger } as const;
