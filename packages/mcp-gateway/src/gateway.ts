import { AsyncLocalStorage } from "node:async_hooks";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { endpoint, GatewayError, publicFetch, restrictedFetch } from "./network.ts";

export interface GatewayLease {
  /** Unique lease generation; restore must create a fresh lease. */
  id: string;
  actorId: string;
  sandboxId: string;
  connectionId: string;
  expiresAt: number;
  url: string;
  transport: "http" | "sse";
}
export interface GatewayAuthorization {
  /** Verify a narrow gateway bearer (never the Armada API bearer), org/private visibility and active sandbox binding. */
  authenticate(request: Request): Promise<GatewayLease>;
  /** Recheck live lease, connection enabled state, grant revocation and membership on every message in BOTH directions. */
  assertActive(lease: GatewayLease): Promise<void>;
  /** Real method/tool authorization, not upstream annotations. Must include server-initiated requests. */
  allow(lease: GatewayLease, direction: "upstream" | "downstream", message: JSONRPCMessage): Promise<boolean>;
  /** Obtain vault credentials server-side; NEVER derive these headers from the incoming request. */
  upstreamHeaders(lease: GatewayLease): Promise<Headers>;
}
export interface GatewayOptions {
  authorization: GatewayAuthorization;
  fetch?: FetchLike;
  now?: () => number;
  /** Exact public gateway origin. Browser Origin, if present, must equal this. */
  origin: string;
  maxSessions?: number;
  /** Independent upstream DELETE budget; integer 1..30000ms, default 5000ms. */
  cleanupTimeoutMs?: number;
}
interface Session {
  lease: GatewayLease;
  downstream: WebStandardStreamableHTTPServerTransport;
  upstream: Transport;
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export function createMcpGateway(options: GatewayOptions) {
  const sessions = new Map<string, Session>();
  const all = new Set<Session>();
  const now = options.now ?? Date.now;
  const auth = options.authorization;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000)
    throw new GatewayError("denied", "Cleanup timeout must be an integer between 1 and 30000 milliseconds.");
  const origin = endpoint(options.origin).origin;
  async function active(lease: GatewayLease) {
    if (lease.expiresAt <= now())
      throw new GatewayError("denied", "Gateway lease expired. Request a new sandbox binding.");
    await auth.assertActive(lease);
  }
  async function create(lease: GatewayLease): Promise<Session> {
    if (all.size >= (options.maxSessions ?? 1000)) throw new GatewayError("busy", "Gateway session capacity reached.");
    const url = endpoint(lease.url);
    // Legacy SSE may advertise a different message path, but never a different origin.
    const fetcher = restrictedFetch(
      options.fetch ?? publicFetch,
      (target) => target.origin === url.origin && (lease.transport === "sse" || target.href === url.href),
    );
    const terminationScope = new AsyncLocalStorage<AbortSignal>();
    const authenticatedFetch: FetchLike = async (input, init) => {
      const request = new Request(input instanceof URL ? input.href : input, init);
      const cleanupSignal = request.method === "DELETE" ? terminationScope.getStore() : undefined;
      const signal = cleanupSignal ? AbortSignal.any([request.signal, cleanupSignal]) : request.signal;
      signal.throwIfAborted();
      await active(lease);
      signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
      const credentials = await auth.upstreamHeaders(lease);
      signal.throwIfAborted();
      for (const [key, value] of credentials) {
        if (
          ["host", "cookie", "proxy-authorization", "mcp-session-id", "connection", "content-length"].includes(
            key.toLowerCase(),
          )
        )
          throw new GatewayError("denied", "Invalid upstream credential header.");
        headers.set(key, value);
      }
      return fetcher(request.url, { method: request.method, headers, body: request.body, signal });
    };
    const upstream: Transport =
      lease.transport === "sse"
        ? new SSEClientTransport(url, { fetch: authenticatedFetch })
        : new StreamableHTTPClientTransport(url, {
            fetch: authenticatedFetch,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 0,
              maxReconnectionDelay: 0,
              reconnectionDelayGrowFactor: 1,
            },
          });
    let cleanupTask: Promise<void> | undefined;
    const downstream = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      keepAliveMs: 0,
      onsessionclosed: () => {
        cleanupTask ??= retire();
        return cleanupTask;
      },
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    type HttpScope = { disconnected: boolean };
    const httpScope = new AsyncLocalStorage<HttpScope>();
    const clientRequests = new Map<RequestId, HttpScope>();
    let closed = false;
    const session: Session = {
      lease,
      upstream,
      downstream,
      async handle(request) {
        const scope: HttpScope = { disconnected: false };
        const response = await httpScope.run(scope, () => downstream.handleRequest(request));
        if (!response.body) return response;
        const reader = response.body.getReader();
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let ended = false;
        const cleanup = () => {
          ended = true;
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          if (ended) return;
          scope.disconnected = true;
          cleanup();
          void reader.cancel().catch(() => {});
          try {
            controller.close();
          } catch {
            /* Response may already be cancelled. */
          }
        };
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
          },
          async pull(value) {
            try {
              const chunk = await reader.read();
              if (ended) return;
              if (chunk.done) {
                cleanup();
                value.close();
              } else value.enqueue(chunk.value);
            } catch (error) {
              if (!ended) {
                cleanup();
                value.error(error);
              }
            }
          },
          cancel(reason) {
            scope.disconnected = true;
            cleanup();
            return reader.cancel(reason);
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        all.delete(session);
        clientRequests.clear();
        if (downstream.sessionId) sessions.delete(downstream.sessionId);
        await Promise.allSettled([upstream.close(), downstream.close()]);
      },
    };
    async function retire() {
      const controller = new AbortController();
      let cancelDeadline = () => {};
      try {
        if (upstream instanceof StreamableHTTPClientTransport) {
          const deadline = new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              controller.abort();
              resolve();
            }, cleanupTimeoutMs);
            cancelDeadline = () => clearTimeout(timer);
          });
          // The SDK has no per-termination signal argument. Scope the cleanup's
          // signal into its authenticated DELETE fetch, not sibling requests.
          // Observe late failure even if a custom fetch ignores abort entirely.
          const attempt = terminationScope.run(controller.signal, () => upstream.terminateSession()).catch(() => {});
          await Promise.race([attempt, deadline]);
        }
      } catch {
        // Cleanup cannot revive credentials or hold local lifecycle hostage.
      } finally {
        try {
          cancelDeadline();
        } finally {
          controller.abort();
          await session.close();
        }
      }
    }
    all.add(session);
    // SDK 1.32.2's HTTP client calls onmessage from its POST SSE/JSON reader
    // without extra correlation metadata. Async-local send scope follows that
    // exact reader, including across awaits, without guessing among active IDs.
    // Initialized notifications and replies deliberately start an uncorrelated
    // scope, so the SDK's standalone GET cannot inherit a tool's POST identity.
    const postRequest = new AsyncLocalStorage<RequestId | undefined>();
    async function relay(message: JSONRPCMessage, direction: "upstream" | "downstream", relatedRequestId?: RequestId) {
      const responseId = "id" in message && !("method" in message) ? message.id : undefined;
      const sourceId = relatedRequestId ?? responseId;
      const sourceScope =
        direction === "downstream" && sourceId !== undefined ? clientRequests.get(sourceId) : undefined;
      try {
        if (sourceScope?.disconnected || (direction === "downstream" && relatedRequestId !== undefined && !sourceScope))
          return;
        await active(lease);
        if (!(await auth.allow(lease, direction, message))) {
          if ("id" in message && "method" in message)
            await (direction === "upstream" ? downstream : upstream).send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Operation denied by gateway policy" },
            });
          else await session.close();
          return;
        }
        if (
          direction === "upstream" &&
          "method" in message &&
          message.method === "initialize" &&
          !SUPPORTED_PROTOCOL_VERSIONS.includes(String(message.params?.protocolVersion))
        ) {
          // This bridge terminates HTTP transport, so negotiate only a version
          // its pinned SDK actually supports, even when the client is newer.
          message = { ...message, params: { ...message.params, protocolVersion: LATEST_PROTOCOL_VERSION } };
        }
        if (
          direction === "downstream" &&
          "result" in message &&
          typeof message.result === "object" &&
          message.result &&
          "protocolVersion" in message.result &&
          typeof message.result.protocolVersion === "string"
        ) {
          if (!SUPPORTED_PROTOCOL_VERSIONS.includes(message.result.protocolVersion)) {
            if ("id" in message)
              await downstream.send({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: -32000,
                  message: "Unsupported upstream MCP protocol version; configure a compatible endpoint.",
                },
              });
            await session.close();
            return;
          }
          upstream.setProtocolVersion?.(message.result.protocolVersion);
        }
        if (direction === "upstream") {
          const requestId = "method" in message && "id" in message ? message.id : undefined;
          await postRequest.run(requestId, () => upstream.send(message));
        } else {
          await downstream.send(message, relatedRequestId === undefined ? undefined : { relatedRequestId });
        }
      } catch {
        if (!sourceScope?.disconnected) await session.close();
      } finally {
        if (direction === "downstream" && responseId !== undefined) clientRequests.delete(responseId);
      }
    }
    downstream.onmessage = (message) => {
      if ("method" in message && "id" in message) {
        const scope = httpScope.getStore();
        if (scope) clientRequests.set(message.id, scope);
      }
      void relay(message, "upstream");
    };
    upstream.onmessage = (message) => {
      void relay(message, "downstream", postRequest.getStore());
    };
    upstream.onerror = () => {
      void session.close();
    };
    upstream.onclose = () => {
      void session.close();
    };
    downstream.onclose = () => {
      void session.close();
    };
    try {
      await downstream.start();
      await upstream.start();
    } catch {
      await session.close();
      throw new GatewayError("needs_reconnect", "Upstream session failed. Reconnect; do not replay uncertain calls.");
    }
    return session;
  }
  return {
    /** Mount on one dedicated gateway URL. Sticky routing is required; unknown sessions are never recreated. */
    async handle(request: Request): Promise<Response> {
      try {
        if (
          new URL(request.url).origin !== origin ||
          (request.headers.has("origin") && request.headers.get("origin") !== origin)
        )
          return new Response(null, { status: 403 });
        if (request.headers.has("last-event-id"))
          return Response.json(
            {
              code: "unsupported",
              action: "Stream replay is unavailable. Reinitialize without replaying uncertain calls.",
            },
            { status: 409 },
          );
        await Promise.all(
          [...all].filter((session) => session.lease.expiresAt <= now()).map((session) => session.close()),
        );
        const lease = await auth.authenticate(request);
        await active(lease);
        const id = request.headers.get("mcp-session-id");
        let session: Session;
        if (id) {
          const found = sessions.get(id);
          if (
            !found ||
            found.lease.id !== lease.id ||
            found.lease.actorId !== lease.actorId ||
            found.lease.sandboxId !== lease.sandboxId ||
            found.lease.connectionId !== lease.connectionId ||
            found.lease.url !== lease.url ||
            found.lease.transport !== lease.transport
          )
            return new Response(null, { status: 404 });
          session = found;
        } else {
          if (request.method !== "POST") return new Response(null, { status: 400 });
          session = await create(lease);
        }
        const response = await session.handle(request);
        if (!id && !session.downstream.sessionId) await session.close();
        return response;
      } catch (error) {
        const failure =
          error instanceof GatewayError
            ? error
            : new GatewayError("denied", "Gateway access unavailable. Request status or reconnect.");
        return Response.json(
          { code: failure.code, action: failure.action },
          { status: failure.code === "denied" ? 403 : failure.code === "busy" ? 409 : 502 },
        );
      }
    },
    /** Registry must call this immediately on disable/revoke/stop; closes live streams, not just future requests. */
    async invalidate(connectionId: string): Promise<void> {
      await Promise.all(
        [...all].filter((session) => session.lease.connectionId === connectionId).map((session) => session.close()),
      );
    },
    async invalidateLease(leaseId: string): Promise<void> {
      await Promise.all([...all].filter((session) => session.lease.id === leaseId).map((session) => session.close()));
    },
    async close(): Promise<void> {
      await Promise.all([...all].map((session) => session.close()));
    },
  };
}
export type McpGateway = ReturnType<typeof createMcpGateway>;
