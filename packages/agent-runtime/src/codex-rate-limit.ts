import type { CodexErrorInfo } from "./codex-schema/v2/CodexErrorInfo.ts";

/** App-server exposes status codes, but currently does not forward Retry-After headers. */
export function codexRateLimited(info: CodexErrorInfo | null | undefined): boolean {
  if (info === "rateLimitExceeded" || info === "serverOverloaded") return true;
  if (!info || typeof info !== "object") return false;
  return Object.values(info).some((value) => {
    const status = value && typeof value === "object" ? (value as { httpStatusCode?: unknown }).httpStatusCode : null;
    return status === 429 || status === 529;
  });
}

export function codexRetryDelay(attempt: number, random = Math.random()): number {
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)) * (0.5 + random * 0.5);
}
