export type LaunchErrorCode =
  | "invalid_request"
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

  constructor(code: LaunchErrorCode, message: string, options?: { cause?: unknown; sandboxId?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.sandboxId = options?.sandboxId;
  }
}
