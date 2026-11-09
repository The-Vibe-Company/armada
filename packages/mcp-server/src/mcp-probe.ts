import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GatewayError, restrictedFetch } from "../../mcp-gateway/src/index.ts";

const DURATION = 15000,
  CLEANUP = 2000,
  PAGES = 64,
  ITEMS = 10000,
  BYTES = 4 * 1024 * 1024,
  CURSOR_BYTES = 2048;
let active = 0;
/** OAuth metadata/token I/O only. Never apply this deadline to live MCP SSE/tool streams. */
export function boundedOAuthFetch(fetcher: FetchLike): FetchLike {
  return async (input, init) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
    const failure = new GatewayError(
      "upstream",
      "OAuth network operation timed out or was cancelled. Reconnect if its outcome is uncertain.",
    );
    let rejectAbort: (reason: unknown) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => rejectAbort(failure);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(), DURATION);
    timer.unref();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    };
    try {
      const response = await Promise.race([fetcher(input, { ...init, signal }), cancelled]);
      signal.throwIfAborted();
      if (!response.body) {
        finish();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await Promise.race([reader.read(), cancelled]);
            if (next.done) {
              finish();
              stream.close();
            } else stream.enqueue(next.value);
          } catch {
            finish();
            stream.error(failure);
          }
        },
        cancel() {
          finish();
          void reader.cancel().catch(() => {});
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      finish();
      if (error instanceof GatewayError) throw error;
      throw failure;
    }
  };
}
class DiscoveryBudget {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private cleanupController = new AbortController();
  private cleaning = false;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout>;
  private abort: () => void;
  private cancelled: Promise<never>;
  readonly fetch: FetchLike;
  constructor(
    fetcher: FetchLike,
    private parent?: AbortSignal,
  ) {
    const deadline = new GatewayError(
      "upstream",
      "MCP discovery exceeded 15 seconds or was cancelled. Retry or reduce the server inventory.",
    );
    this.abort = () => this.controller.abort(deadline);
    this.cancelled = new Promise<never>((_resolve, reject) =>
      this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true }),
    );
    this.timer = setTimeout(this.abort, DURATION);
    this.timer.unref();
    parent?.addEventListener("abort", this.abort, { once: true });
    if (parent?.aborted) this.abort();
    this.fetch = async (input, init) => {
      const signal = AbortSignal.any([
        this.cleaning ? this.cleanupController.signal : this.signal,
        ...(init?.signal ? [init.signal] : []),
      ]);
      signal.throwIfAborted();
      const response = await fetcher(input, { ...init, signal });
      if (!response.body) return response;
      const budget = this;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            budget.bytes += chunk.byteLength;
            if (budget.bytes > BYTES) {
              const error = new GatewayError(
                "unsupported",
                "MCP discovery exceeds the 4 MiB response budget. Reduce the exposed inventory.",
              );
              budget.controller.abort(error);
              stream.error(error);
              return;
            }
            stream.enqueue(chunk);
          },
        }),
        { signal },
      );
      return new Response(body, {
        status: response.status,
        headers: response.headers,
        statusText: response.statusText,
      });
    };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await Promise.race([work(), this.cancelled]);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (this.signal.aborted) throw this.signal.reason;
      throw new GatewayError("upstream", "MCP probe failed. Verify endpoint, authentication and transport.");
    }
  }
  async cleanup(work: () => Promise<void>) {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.abort);
    this.cleaning = true;
    this.controller.abort(new GatewayError("upstream", "MCP discovery completed."));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.cleanupController.abort();
            resolve();
          }, CLEANUP);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.cleanupController.abort();
    }
  }
}
/** Shared operation-wide budget also bounds OAuth/public discovery metadata reads. */
export async function withMcpDiscoveryBudget<T>(
  fetcher: FetchLike,
  signal: AbortSignal | undefined,
  work: (fetch: FetchLike, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (active >= 8) throw new GatewayError("busy", "MCP discovery capacity reached. Retry shortly.");
  active++;
  const budget = new DiscoveryBudget(fetcher, signal);
  try {
    return await budget.run(() => work(budget.fetch, budget.signal));
  } finally {
    await budget.cleanup(async () => {});
    active--;
  }
}

/** Real SDK inventory probe. Never returns partial counts after a limit or protocol failure. */
export async function probeRemoteMcp(input: {
  url: string;
  transport: "http" | "sse";
  headers: Headers | ((fetch: FetchLike, signal: AbortSignal) => Promise<Headers>);
  fetch: FetchLike;
  signal?: AbortSignal;
}) {
  if (active >= 8) throw new GatewayError("busy", "MCP discovery capacity reached. Retry shortly.");
  active++;
  const budget = new DiscoveryBudget(input.fetch, input.signal);
  const url = new URL(input.url);
  const exact = restrictedFetch(
    budget.fetch,
    (target) => target.origin === url.origin && (input.transport === "sse" || target.href === url.href),
  );
  let headers = new Headers();
  const authenticated: FetchLike = (target, init) =>
    exact(target, {
      ...init,
      headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...Object.fromEntries(headers) }),
    });
  const transport =
    input.transport === "sse"
      ? new SSEClientTransport(url, { fetch: authenticated })
      : new StreamableHTTPClientTransport(url, {
          fetch: authenticated,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 0,
            maxReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        });
  const client = new Client({ name: "Armada connection probe", version: "1" });
  let pages = 0,
    total = 0;
  async function count(list: (cursor: string | undefined) => Promise<{ length: number; nextCursor?: string }>) {
    let cursor: string | undefined,
      count = 0;
    const seen = new Set<string>();
    for (;;) {
      budget.signal.throwIfAborted();
      if (++pages > PAGES)
        throw new GatewayError("unsupported", "MCP inventory exceeds 64 pages. Reduce the exposed inventory.");
      const page = await list(cursor);
      total += page.length;
      count += page.length;
      if (total > ITEMS)
        throw new GatewayError("unsupported", "MCP inventory exceeds 10000 items. Reduce the exposed inventory.");
      if (page.nextCursor === undefined) return count;
      if (new TextEncoder().encode(page.nextCursor).byteLength > CURSOR_BYTES || seen.has(page.nextCursor))
        throw new GatewayError(
          "unsupported",
          "MCP server returned an oversized or repeated pagination cursor. Fix server pagination.",
        );
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  const request = {
    signal: budget.signal,
    timeout: DURATION,
    maxTotalTimeout: DURATION,
    resetTimeoutOnProgress: false,
  };
  try {
    return await budget.run(async () => {
      headers = input.headers instanceof Headers ? input.headers : await input.headers(budget.fetch, budget.signal);
      budget.signal.throwIfAborted();
      await client.connect(transport, request);
      const capabilities = client.getServerCapabilities();
      const toolCount = capabilities?.tools
        ? await count(async (cursor) => {
            const page = await client.listTools(cursor === undefined ? {} : { cursor }, request);
            return {
              length: page.tools.length,
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            };
          })
        : 0;
      const resourceCount = capabilities?.resources
        ? await count(async (cursor) => {
            const page = await client.listResources(cursor === undefined ? {} : { cursor }, request);
            return {
              length: page.resources.length,
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            };
          })
        : 0;
      const promptCount = capabilities?.prompts
        ? await count(async (cursor) => {
            const page = await client.listPrompts(cursor === undefined ? {} : { cursor }, request);
            return {
              length: page.prompts.length,
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            };
          })
        : 0;
      return { toolCount, resourceCount, promptCount };
    });
  } finally {
    await budget
      .cleanup(async () => {
        try {
          if (transport instanceof StreamableHTTPClientTransport && transport.sessionId)
            await transport.terminateSession();
        } finally {
          await client.close();
        }
      })
      .catch(() => {});
    active--;
  }
}
