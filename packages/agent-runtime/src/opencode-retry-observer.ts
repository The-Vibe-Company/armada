import { Agent, type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection, createServer } from "node:net";
import { Readable } from "node:stream";
import type { AcpObservation } from "./acp.ts";
import { HarnessError } from "./errors.ts";
import type { ModelRateLimitWait } from "./model-rate-limit.ts";
import type { DriverContext } from "./protocol.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Pinned OpenCode 1.19.5 /event emits session.status directly, unlike /global/event's payload envelope. */
async function readOpenCodeRetryEvents(
  stream: ReadableStream<Uint8Array>,
  sessionId: string,
  observe: (delayMs: number, reason?: "model_provider_retry") => void,
  signal: AbortSignal,
  now = Date.now,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let frameBytes = 0;
  let discard = false;
  let previousRetry: string | undefined;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!discard && line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "");
          data.push(value);
          frameBytes += Buffer.byteLength(value);
          if (frameBytes > 16 * 1024 * 1024) {
            discard = true;
            data = [];
          }
        }
        if (line !== "") continue;
        if (!discard && data.length) {
          const event: unknown = JSON.parse(data.join("\n"));
          if (object(event) && event.type === "session.status" && object(event.properties)) {
            const { sessionID, status } = event.properties;
            if (sessionID === sessionId && object(status) && status.type === "retry") {
              const { attempt, next, message, action } = status;
              const throttled =
                (object(action) && ["account_rate_limit", "free_tier_limit"].includes(String(action.reason))) ||
                (typeof message === "string" &&
                  /\b429\b|\b529\b|rate[ _-]?limit|too[ _-]many[ _-]requests|overloaded|at capacity/i.test(message));
              if (
                typeof attempt === "number" &&
                Number.isSafeInteger(attempt) &&
                attempt >= 0 &&
                typeof next === "number" &&
                Number.isSafeInteger(next) &&
                next >= 0
              ) {
                const key = `${attempt}:${next}`;
                if (previousRetry !== key) {
                  previousRetry = key;
                  // OpenCode does not retain HTTP status here. Every native retry must be
                  // visible, without mislabelling network/ambiguous provider failures as throttles.
                  observe(Math.max(0, next - now()), throttled ? undefined : "model_provider_retry");
                }
              }
            }
          }
        }
        data = [];
        frameBytes = 0;
        discard = false;
      }
      // Unrelated native tool/message frames can be large. Drop them without ending the turn,
      // but retain the SSE frame boundary so later retry status remains observable.
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        discard = true;
        data = [];
        buffer = "";
      }
    }
    if (!signal.aborted) throw new HarnessError("harness_process_lost");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new HarnessError("harness_failed"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Each ACP process owns an authenticated loopback HTTP event stream; no credential enters argv or journals. */
export async function createOpenCodeRetryObserver(
  c: DriverContext,
  waits: ModelRateLimitWait,
): Promise<{
  args: string[];
  env: Record<string, string>;
  observation: AcpObservation;
}> {
  const port = await loopbackPort();
  c.signal.throwIfAborted();
  const password = crypto.randomUUID();
  const controller = new AbortController();
  // Never use fetch/globalAgent here: readable account configuration may set HTTP_PROXY.
  // The private agent dials only this process's loopback server, irrespective of proxy environment.
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => createConnection({ host: "127.0.0.1", port });
  let request: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  let pump: Promise<void> | undefined;
  const abort = () => controller.abort();
  c.signal.addEventListener("abort", abort, { once: true });
  const observation: AcpObservation = {
    failed,
    ready: async (sessionId) => {
      const timer = setTimeout(abort, 5000);
      try {
        const url = new URL(`http://127.0.0.1:${port}/event`);
        url.searchParams.set("directory", c.request.cwd ?? "");
        const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
          request = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              method: "GET",
              path: `${url.pathname}${url.search}`,
              agent,
              headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
              signal: controller.signal,
            },
            resolve,
          );
          request.once("error", reject);
          request.end();
        });
        incoming = response;
        // node:http does not follow redirects; never send the credential to a redirect destination.
        if (response.statusCode !== 200 || !response.headers["content-type"]?.startsWith("text/event-stream")) {
          response.destroy();
          throw new HarnessError("invalid_harness_protocol");
        }
        pump = readOpenCodeRetryEvents(
          Readable.toWeb(response) as ReadableStream<Uint8Array>,
          sessionId,
          (delay, reason) => waits.observe(c, delay, reason),
          controller.signal,
        ).catch(() => {
          if (!controller.signal.aborted) rejectFailure(new HarnessError("harness_process_lost"));
        });
      } catch {
        throw new HarnessError("harness_process_lost");
      } finally {
        clearTimeout(timer);
      }
    },
    close: async () => {
      controller.abort();
      incoming?.destroy();
      request?.destroy();
      agent.destroy();
      c.signal.removeEventListener("abort", abort);
      await pump;
    },
  };
  return {
    args: ["acp", "--hostname", "127.0.0.1", "--port", String(port)],
    env: { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
    observation,
  };
}
