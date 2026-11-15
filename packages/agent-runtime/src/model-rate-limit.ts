import { setTimeout as sleep } from "node:timers/promises";
import type { DriverContext } from "./protocol.ts";

/** Shared request backoff. Native harnesses own in-flight retries; call only after terminal throttles. */
export function modelRetryDelay(
  attempt: number,
  random = Math.random(),
  retryAfter?: string,
  now = Date.now(),
): number {
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const delay = retryAfter.trim() !== "" && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay) && delay >= 0) return Math.min(300_000, delay);
  }
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)) * (0.5 + random * 0.5);
}

export class ModelRateLimitWait {
  private count = 0;
  private total = 0;
  private controller = new AbortController();
  cancel() {
    this.controller.abort();
  }
  async wait(c: DriverContext, retryAfter?: string): Promise<void> {
    c.signal.throwIfAborted();
    const delayMs = modelRetryDelay(this.count, undefined, retryAfter);
    this.observe(c, delayMs);
    await sleep(delayMs, undefined, { signal: AbortSignal.any([c.signal, this.controller.signal]) });
  }
  observe(c: DriverContext, delayMs: number, reason?: "model_provider_retry"): void {
    this.count++;
    this.total += delayMs;
    c.emit({
      kind: "other",
      type: "armada/modelRateLimit",
      data: {
        retryCount: this.count,
        delayMs,
        totalWaitMs: this.total,
        ...(reason ? { reason } : {}),
        message:
          reason === "model_provider_retry"
            ? `Model provider request retrying in ${Math.ceil(delayMs / 1000)} s`
            : `Rate limited by the model provider, retrying in ${Math.ceil(delayMs / 1000)} s`,
      },
    });
  }
}

/** Inspect only structured protocol metadata, never arbitrary model/tool text. */
export function modelThrottle(value: unknown): { retryAfter?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const status = v.statusCode ?? v.status ?? v.httpStatusCode;
  if (status === 429 || status === 529) {
    const headers = v.responseHeaders ?? v.headers;
    const retry =
      headers && typeof headers === "object" ? (headers as Record<string, unknown>)["retry-after"] : undefined;
    return typeof retry === "string" ? { retryAfter: retry } : {};
  }
  for (const key of ["data", "error", "cause"]) {
    if (v[key] && v[key] !== value) {
      // Wire JSON has no cycles; limit traversal to its known error envelopes.
      const nested = v[key] as Record<string, unknown>;
      if (nested && typeof nested === "object") {
        const status = nested.statusCode ?? nested.status ?? nested.httpStatusCode;
        if (status === 429 || status === 529) return modelThrottle(nested);
      }
    }
  }
}
