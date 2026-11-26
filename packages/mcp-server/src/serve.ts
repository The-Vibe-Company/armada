import type { ServerWebSocket } from "bun";
import { createHandler } from "./http.ts";
import { assembleServer } from "./modules.ts";
import type { RelaySocketData } from "./relay-hub.ts";
import { PREVIEW_WS_MAX_PAYLOAD, type PreviewWsSocketData } from "./relay-preview.ts";
import { BUN_REQUEST_BODY_BACKSTOP, ingressRequest } from "./request-body-ceiling.ts";
import { currentRequestId, observeRequest, REQUEST_ID_HEADER } from "./request-observability.ts";
import type { RuntimeSocketData } from "./runtime-sockets.ts";
import { createServerRequestDrain } from "./server-request-drain.ts";
import { createServerServices, type ServerOptions } from "./server-services.ts";
import { installServerShutdown } from "./server-shutdown.ts";
import { createPgNotifyClient } from "./sql.ts";
import { runtimeWakes, startEventNotifyListener } from "./wake-bus.ts";

export { bunSql } from "./sql.ts";

type ServerSocketData = ({ kind: "channel" } & RuntimeSocketData) | RelaySocketData | PreviewWsSocketData;

export async function startServer(env: Record<string, string | undefined>, options: ServerOptions = {}) {
  const services = await createServerServices(env, options);
  const { config, control, runtimeSockets, relayHub, relayPreview } = services;
  const eventStreamShutdown = new AbortController();
  control.eventStreamShutdown = eventStreamShutdown.signal;
  control.stopAdmissionShutdown = eventStreamShutdown.signal;
  const assembly = assembleServer(services);
  let configureRequestTimeout: ((request: Request, seconds: number) => void) | undefined;
  const handler = createHandler({
    ...services.handlerOptions,
    routes: assembly.mounts((request, seconds) => configureRequestTimeout?.(request, seconds)),
  });
  assembly.startBeforeListen();
  const requestDrain = createServerRequestDrain(handler, options.logError);
  const { fetch, requests } = requestDrain;
  const server = Object.assign(
    Bun.serve<ServerSocketData>({
      port: config.port,
      hostname: "0.0.0.0",
      // The 128 MiB ingress ceiling is enforced by the observed handler, so its 413 carries the
      // request ID and record; Bun's own limit is only a backstop. Control JSON (128 KiB) and
      // broker (1 KiB) stay bounded per route.
      maxRequestBodySize: BUN_REQUEST_BODY_BACKSTOP,
      fetch: (request, instance) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/runtime/channel") {
          return observeRequest(
            () => {
              // Read the ID here: the upgrade callback runs inside a database session callback.
              const id = currentRequestId()!;
              return runtimeSockets.upgrade(request, (data) =>
                instance.upgrade(request, {
                  data: { kind: "channel", ...data },
                  headers: { [REQUEST_ID_HEADER]: id },
                }),
              );
            },
            options.logError,
            request,
          );
        }
        if (pathname === "/api/runtime/relay" || pathname === "/api/v1/relay/ws") {
          return observeRequest(
            () => {
              const id = currentRequestId()!;
              const upgrade = pathname === "/api/runtime/relay" ? relayHub.upgradeRuntime : relayHub.upgradeClient;
              return upgrade(request, (data) =>
                instance.upgrade(request, { data, headers: { [REQUEST_ID_HEADER]: id } }),
              );
            },
            options.logError,
            request,
          );
        }
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && relayPreview.isPreviewPath(pathname)) {
          return observeRequest(
            () => {
              const id = currentRequestId()!;
              return relayPreview.upgradeWebSocket(request, (data, headers) =>
                instance.upgrade(request, { data, headers: { [REQUEST_ID_HEADER]: id, ...headers } }),
              );
            },
            options.logError,
            request,
          );
        }
        return fetch(request);
      },
      error: (error) =>
        observeRequest(() => {
          throw error;
        }, options.logError),
      websocket: {
        ...relayHub.websocket,
        maxPayloadLength: Math.max(relayHub.websocket.maxPayloadLength ?? 0, PREVIEW_WS_MAX_PAYLOAD),
        open(s) {
          if (s.data.kind === "channel")
            return runtimeSockets.websocket.open?.(s as ServerWebSocket<RuntimeSocketData>);
          if (s.data.kind === "preview-ws")
            return relayPreview.websocket.open?.(s as ServerWebSocket<PreviewWsSocketData>);
          return relayHub.websocket.open?.(s as ServerWebSocket<RelaySocketData>);
        },
        message(s, m) {
          if (s.data.kind === "channel")
            return runtimeSockets.websocket.message(s as ServerWebSocket<RuntimeSocketData>, m);
          if (s.data.kind === "preview-ws")
            return relayPreview.websocket.message(s as ServerWebSocket<PreviewWsSocketData>, m);
          return relayHub.websocket.message(s as ServerWebSocket<RelaySocketData>, m);
        },
        close(s, c, r) {
          if (s.data.kind === "channel")
            return runtimeSockets.websocket.close?.(s as ServerWebSocket<RuntimeSocketData>, c, r);
          if (s.data.kind === "preview-ws")
            return relayPreview.websocket.close?.(s as ServerWebSocket<PreviewWsSocketData>, c, r);
          return relayHub.websocket.close?.(s as ServerWebSocket<RelaySocketData>, c, r);
        },
      },
    }),
    {
      workerDone: Promise.resolve(),
    },
  );
  // Cold image pulls and scoped child admission can exceed Bun's default ten-second idle window.
  // Normal Docker launches and scoped child mutations use their own operation deadlines.
  // Other routes retain their existing response timeout policy.
  control.configureAntigravityLoginRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureStopRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureScopedMutationRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureEventStreamRequest = (request) => server.timeout(ingressRequest(request), 30);
  // Held Docker polls, archive uploads and artifact downloads set their own bounded ingress timeouts.
  configureRequestTimeout = (request, seconds) => server.timeout(ingressRequest(request), seconds);
  const workers = assembly.planWorkers().start();
  const eventNotify = startEventNotifyListener(
    () => createPgNotifyClient(config.databaseUrl),
    runtimeWakes,
    options.logError,
  );
  installServerShutdown(server, {
    ...assembly.shutdown,
    closePools: () => Promise.allSettled([eventNotify.close()]).then(() => assembly.shutdown.closePools()),
    closeAntigravityLogin: () => control.antigravityLogin?.shutdown(),
    beginDrain: () => {
      requestDrain.beginDrain();
      eventStreamShutdown.abort();
      workers.stop();
    },
    workersDone: workers.done,
    drainModalArtifacts: () => services.modalArtifactCache?.drain(),
    requests,
  });
  // Expose the tracked task for hosts that gracefully drain before process termination.
  Object.assign(server, { lifecycleWorker: workers.lifecycleWorker });
  server.workerDone = workers.done;
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
