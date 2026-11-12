/** Safe presentation data, not a new failure category. Unknown upstream fields never leave the server. */
export interface ProviderRateLimitDetails {
  provider?: "boat";
  window?: "minute" | "hour" | "day" | "concurrency";
  nextStartAt?: string;
  retryAfterSeconds?: number;
}

export function providerRateLimitDetails(value: unknown): ProviderRateLimitDetails {
  const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const result: ProviderRateLimitDetails = {};
  if (input.provider === "boat") result.provider = "boat";
  if (input.window === "minute" || input.window === "hour" || input.window === "day" || input.window === "concurrency")
    result.window = input.window;
  if (
    typeof input.nextStartAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.nextStartAt) &&
    Number.isFinite(Date.parse(input.nextStartAt))
  )
    result.nextStartAt = new Date(input.nextStartAt).toISOString();
  if (
    typeof input.retryAfterSeconds === "number" &&
    Number.isSafeInteger(input.retryAfterSeconds) &&
    input.retryAfterSeconds >= 0 &&
    input.retryAfterSeconds <= 31_536_000
  )
    result.retryAfterSeconds = input.retryAfterSeconds;
  return result;
}

/** Closed copy built only from validated fields; never display the upstream message or guess a reset time. */
export function providerRateLimitMessage(value: unknown): string {
  const detail = providerRateLimitDetails(value);
  const name = detail.provider === "boat" ? "Boat" : "provider";
  const period =
    detail.window === "minute" || detail.window === "hour" || detail.window === "day" ? detail.window : null;
  const limit = period ? `plan start limit per ${period}` : "account rate or capacity limit";
  const timing = detail.nextStartAt
    ? ` ${name === "Boat" ? "Boat" : "The provider"} says the next start is available at ${detail.nextStartAt}.`
    : detail.retryAfterSeconds === undefined
      ? ""
      : ` Wait at least ${detail.retryAfterSeconds} seconds before another start.`;
  return `The ${name} ${limit} has been reached.${timing} Check the selected provider account's plan and limits before another start.`;
}
