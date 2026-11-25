export class DataError extends Error {
  override readonly name = "DataError";
  constructor(
    message: string,
    readonly code: "unavailable" | "sandbox_not_ready" | "not_found" | "invalid" = "unavailable",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
