/** A failure the CLI can show. The message never includes a token or a key. */
export class AuthError extends Error {
  readonly code: "usage" | "unauthorized" | "conflict" | "unavailable";

  /** `cause` is for the server's log: the HTTP status or the driver error, never a token or a key. */
  constructor(message: string, code: "usage" | "unauthorized" | "conflict" | "unavailable", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthError";
    this.code = code;
  }
}
