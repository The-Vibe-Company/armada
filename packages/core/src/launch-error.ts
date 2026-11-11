import type { HelperRefusal } from "./helper.ts";
export const LAUNCH_INITIALIZATION_STAGES = [
  "initialization_bind",
  "initialization_ready",
  "initialization_hydrate",
  "initialization_github",
  "initialization_repository",
  "initialization_commands",
  "initialization_cwd",
  "initialization_mcp",
  "initialization_publish",
] as const;
export type LaunchInitializationStage = (typeof LAUNCH_INITIALIZATION_STAGES)[number];
export const LAUNCH_FAILURE_REASONS = [
  "github_setup_background",
  "github_setup_timeout",
  "github_setup_nonzero",
  "native_auth_write_failed",
  "repository_ownership_mismatch",
  "visibility_not_persisted",
] as const;
export type LaunchFailureReason = (typeof LAUNCH_FAILURE_REASONS)[number];

import type { ApiFailureCode } from "./api-failure.ts";

export type LaunchErrorCode =
  | ApiFailureCode
  | "invalid_request"
  | "unsupported"
  /** The harness has no credential for the caller or the org. */
  | "no_credentials"
  /** The sandbox failed to start, or a provider call failed while launching. */
  | "start_failed"
  /** A `git pull` or an init command failed. The message holds its output. */
  | "init_failed"
  /** The sandbox is set up but the first prompt was refused. */
  | "prompt_failed";

export class LaunchError extends Error {
  override readonly name = "LaunchError";
  readonly code: LaunchErrorCode;
  /** Armada's id of the sandbox that was recorded before the failure, when there was one. */
  readonly sandboxId: string | undefined;
  readonly safeReason: LaunchFailureReason | undefined;
  readonly reason: HelperRefusal["reason"] | undefined;
  readonly action: HelperRefusal["action"] | undefined;

  constructor(
    code: LaunchErrorCode,
    message: string,
    options?: { cause?: unknown; sandboxId?: string; safeReason?: LaunchFailureReason; helperRefusal?: HelperRefusal },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.sandboxId = options?.sandboxId;
    this.safeReason = options?.safeReason;
    this.reason = options?.helperRefusal?.reason;
    this.action = options?.helperRefusal?.action;
  }
}
