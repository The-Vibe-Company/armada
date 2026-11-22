export class AuthError extends Error {
  readonly code: "usage" | "unauthorized" | "conflict" | "unavailable" | "rate_limited";

  constructor(
    message: string,
    code: "usage" | "unauthorized" | "conflict" | "unavailable" | "rate_limited",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthError";
    this.code = code;
  }
}
