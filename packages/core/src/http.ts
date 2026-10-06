// Shared request deadlines and explicitly safe retries. A deadline includes the
// response body; getting headers alone is not an answer.
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class HttpRequestError extends Error {
  override name = "HttpRequestError";
  constructor(
    error: unknown,
    timeoutMs: number,
    readonly attempts: number,
    /** Whether the underlying deadline/network failure was eligible for safe retry. */
    readonly transient = false,
  ) {
    super(
      `${networkReason(error, timeoutMs)}${attempts > 1 ? `; failed after ${attempts} attempts (${attempts === 2 ? "one retry" : `${attempts - 1} retries`})` : ""}`,
    );
  }
}

export function networkReason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  const code = codeOf(err);
  // Only known diagnostic code shapes are echoed; all codes still participate in retry eligibility.
  const visible = code && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|ConnectionClosed|ConnectionRefused)$/.test(code) ? code : null;
  const message = err instanceof Error ? err.message : String(err);
  return visible && !message.includes(visible) ? `${message} (${visible})` : message;
}

function codeOf(error: unknown): string | null {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const e = error as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string") return e.code;
    error = e.cause;
  }
  return null;
}

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const code = codeOf(error);
  if (code)
    return /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|ConnectionClosed|ConnectionRefused)$/.test(
      code,
    );
  return error instanceof TypeError && error.message === "fetch failed";
}

export const retryStatus = (status: number): boolean => [408, 429, 500, 502, 503, 504].includes(status);

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    retryAfter: string,
  ) {
    super(`HTTP ${status}; try again after ${retryAfter}`);
  }
}

/** Shared retry controls, supplied by adapters and driven without wall-clock waits in tests. */
export interface HttpRetryOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  onRetry?: (message: string) => void;
}

function retryAfterMs(value: string | null, now: () => Date): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now().getTime()) : null;
}

/** Also races caller cancellation while waiting; a cancelled call never starts another attempt. */
async function wait(ms: number, opts: HttpRetryOptions, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try {
    await Promise.race([
      (
        opts.sleep ??
        ((ms) =>
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
          }))
      )(ms),
      cancelled,
    ]);
    signal?.throwIfAborted();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export interface HttpRequestOptions extends HttpRetryOptions {
  fetch?: Fetch;
  /** Only known safe operations may opt in, including reads transported as POST. */
  retry?: boolean;
  retryStatus?: (status: number) => boolean;
  /** A public service name, never a URL or request body. */
  service?: string;
  /** Existing explicit deadlines cap each attempt, including the longer retry. */
  timeoutMs?: number;
  /** Tests drive a deadline without waiting for a real timer. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export async function httpRequest<T>(
  url: string,
  init: RequestInit,
  opts: HttpRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  init.signal?.throwIfAborted();
  const doFetch = opts.fetch ?? fetch;
  const attempts = opts.retry ? (opts.retryStatus ? 3 : 2) : 1;
  let transportRetries = 0;
  let waitedMs = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const limit = opts.retry
      ? Math.min(opts.timeoutMs ?? 30_000, attempt === 1 ? 5000 : 10_000)
      : (opts.timeoutMs ?? 30_000);
    const deadline = (opts.timeoutSignal ?? AbortSignal.timeout)(limit);
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    let response: Response | undefined;
    let fetchFailed = false;
    let pause: { status: number; ms: number } | undefined;
    let onDeadline: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      onDeadline = () => {
        controller.abort(deadline.reason);
        reject(deadline.reason);
      };
      deadline.addEventListener("abort", onDeadline, { once: true });
      if (deadline.aborted) onDeadline();
    });
    try {
      const answer = await Promise.race([
        expired,
        (async () => {
          try {
            response = await doFetch(url, { ...init, signal });
            signal.throwIfAborted();
          } catch (error) {
            fetchFailed = true;
            throw error;
          }
          if (opts.retry && opts.retryStatus?.(response.status)) {
            const after = retryAfterMs(response.headers.get("Retry-After"), opts.now ?? (() => new Date()));
            const remaining = 14_000 - waitedMs;
            if (response.status === 429 && after !== null && after > Math.min(10_000, remaining))
              throw new HttpStatusError(429, `${after / 1000} s`);
            if (attempt < attempts) {
              const base = attempt === 1 ? 1000 : 3000;
              // Cap each wait at 10 s and total extra waiting at 14 s.
              // A rate limit that exceeds the remaining budget fails above.
              const jitter = base * (0.8 + (opts.random ?? Math.random)() * 0.4);
              pause = {
                status: response.status,
                ms: Math.min(10_000, remaining, Math.max(after ?? 0, Math.round(jitter))),
              };
              // This response is discarded; draining it would buffer an unbounded error body.
              await response.body?.cancel().catch(() => {});
              return undefined;
            }
          }
          return read(response);
        })(),
      ]);
      if (!pause) return answer as T;
    } catch (error) {
      // A transport wrapper may compose caller cancellation into its own signal.
      // Only our deadline is a reason to retry an AbortError.
      if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError" && !deadline.aborted))
        throw error;
      const cause = deadline.aborted ? deadline.reason : error;
      const transport = fetchFailed || deadline.aborted || transient(cause);
      if (!transport) throw error;
      if (attempt < attempts && transportRetries < 1 && (!response || response.ok) && transient(cause)) {
        transportRetries++;
        continue;
      }
      throw new HttpRequestError(cause, limit, attempt, transient(cause));
    } finally {
      deadline.removeEventListener("abort", onDeadline);
      // Abort closes a failed request's socket; its retry gets a new signal.
      controller.abort();
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    }
    if (pause) {
      opts.onRetry?.(
        `${opts.service ?? "Service"} answered ${pause.status}; trying again in ${Math.round(pause.ms / 100) / 10} s (${attempt + 1}/${attempts})`,
      );
      waitedMs += pause.ms;
      await wait(pause.ms, opts, init.signal);
    }
  }
  throw new Error("unreachable request attempt");
}
