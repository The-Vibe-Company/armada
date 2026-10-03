// Shared request deadlines and explicitly safe retries. A deadline includes the
// response body; getting headers alone is not an answer.
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class HttpRequestError extends Error {
  override name = "HttpRequestError";
  constructor(
    error: unknown,
    timeoutMs: number,
    readonly attempts: number,
  ) {
    super(`${networkReason(error, timeoutMs)}${attempts > 1 ? "; failed after 2 attempts (one retry)" : ""}`);
  }
}

export function networkReason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  const code = codeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function codeOf(error: unknown): string | null {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const e = error as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|ConnectionClosed|ConnectionRefused)$/.test(e.code))
      return e.code;
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

export interface HttpRequestOptions {
  fetch?: Fetch;
  /** Only known idempotent reads may opt in, including reads transported as POST. */
  retry?: boolean;
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
  const attempts = opts.retry ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const limit = opts.retry
      ? Math.min(opts.timeoutMs ?? 30_000, attempt === 1 ? 5000 : 10_000)
      : (opts.timeoutMs ?? 30_000);
    const deadline = (opts.timeoutSignal ?? AbortSignal.timeout)(limit);
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    let response: Response | undefined;
    let fetchFailed = false;
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
      return await Promise.race([
        expired,
        (async () => {
          try {
            response = await doFetch(url, { ...init, signal });
            signal.throwIfAborted();
          } catch (error) {
            fetchFailed = true;
            throw error;
          }
          return read(response);
        })(),
      ]);
    } catch (error) {
      // A transport wrapper may compose caller cancellation into its own signal.
      // Only our deadline is a reason to retry an AbortError.
      if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError" && !deadline.aborted))
        throw error;
      const cause = deadline.aborted ? deadline.reason : error;
      const transport = fetchFailed || deadline.aborted || transient(cause);
      if (!transport) throw error;
      if (attempt < attempts && (!response || response.ok) && transient(cause)) continue;
      throw new HttpRequestError(cause, limit, attempt);
    } finally {
      deadline.removeEventListener("abort", onDeadline);
      // Abort closes a failed request's socket; its retry gets a new signal.
      controller.abort();
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    }
  }
  throw new Error("unreachable request attempt");
}
