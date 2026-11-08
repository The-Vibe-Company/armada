/** A failure the CLI can show. The message never includes a token or a key. */
export class AuthError extends Error {
  readonly code: "usage" | "unauthorized" | "conflict" | "unavailable";

  constructor(message: string, code: "usage" | "unauthorized" | "conflict" | "unavailable") {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
