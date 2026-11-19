import type { z } from "zod";
import { launchInput } from "./launch.ts";
import { launchOutput } from "./launch-response.ts";

export type { LaunchInput } from "./launch.ts";
export { type LaunchEnvelope, launchEnvelope, templateLaunchResponse } from "./launch-response.ts";

export interface Operation<Input extends z.ZodType, Output extends z.ZodType | undefined = undefined> {
  readonly name: string;
  readonly route: { readonly method: string; readonly path: `/api/v1/${string}` };
  readonly input: { readonly body: Input };
  readonly output: Output;
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

export const operations = { launch } as const;
