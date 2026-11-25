import type { ApiFailureCode } from "./api-failure.ts";
import type { HelperRefusal } from "./helper.ts";
import type { PrivateSkillError, PrivateSkillFailure } from "./private-skill-error.ts";

export type LaunchInitializationStage =
  | "initialization_bind"
  | "initialization_ready"
  | "initialization_hydrate"
  | "initialization_github"
  | "initialization_repository"
  | "initialization_commands"
  | "initialization_cwd"
  | "initialization_mcp"
  | "initialization_publish";

export type LaunchErrorCode =
  | ApiFailureCode
  | "invalid_request"
  | "unsupported"
  /** A configured repository needs a GitHub connection with read access. */
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
  readonly safeReason: "repository_ownership_mismatch" | undefined;
  readonly reason: HelperRefusal["reason"] | PrivateSkillFailure | undefined;
  readonly stage: PrivateSkillError["stage"] | undefined;
  readonly skillFailure: { reason: PrivateSkillFailure; stage: PrivateSkillError["stage"] } | undefined;
  readonly action: HelperRefusal["action"] | undefined;

  constructor(
    code: LaunchErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      sandboxId?: string;
      safeReason?: "repository_ownership_mismatch";
      helperRefusal?: HelperRefusal;
      skillFailure?: { reason: PrivateSkillFailure; stage: PrivateSkillError["stage"] };
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.sandboxId = options?.sandboxId;
    this.safeReason = options?.safeReason;
    this.reason = options?.skillFailure?.reason ?? options?.helperRefusal?.reason;
    this.stage = options?.skillFailure?.stage;
    this.skillFailure = options?.skillFailure;
    this.action = options?.helperRefusal?.action;
  }
}
