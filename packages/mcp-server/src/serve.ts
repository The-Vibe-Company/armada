import { createHandler } from "./http.ts";
import { assembleServer } from "./modules.ts";
import { BUN_REQUEST_BODY_BACKSTOP, ingressRequest } from "./request-body-ceiling.ts";
import { currentRequestId, observeRequest, REQUEST_ID_HEADER } from "./request-observability.ts";
import type { RuntimeSocketData } from "./runtime-sockets.ts";
import { createServerRequestDrain } from "./server-request-drain.ts";
import { createServerServices, type ServerOptions } from "./server-services.ts";
import { installServerShutdown } from "./server-shutdown.ts";

export { bunSql } from "./sql.ts";

export async function startServer(env: Record<string, string | undefined>, options: ServerOptions = {}) {
  const services = await createServerServices(env, options);
  const { config, control, runtimeSockets } = services;
  const eventStreamShutdown = new AbortController();
  control.eventStreamShutdown = eventStreamShutdown.signal;
  control.stopAdmissionShutdown = eventStreamShutdown.signal;
  const assembly = assembleServer(services);
  let configureDockerArchiveTimeout: ((request: Request) => void) | undefined;
  const handler = createHandler({
    ...services.handlerOptions,
    routes: assembly.mounts((request) => configureDockerArchiveTimeout?.(request)),
  });
  assembly.startBeforeListen();
  const requestDrain = createServerRequestDrain(handler, options.logError);
  const { fetch, requests } = requestDrain;
  const server = Object.assign(
    Bun.serve<RuntimeSocketData>({
      port: config.port,
      hostname: "0.0.0.0",
      // The 128 MiB ingress ceiling is enforced by the observed handler, so its 413 carries the
      // request ID and record; Bun's own limit is only a backstop. Control JSON (128 KiB) and
      // broker (1 KiB) stay bounded per route.
      maxRequestBodySize: BUN_REQUEST_BODY_BACKSTOP,
      fetch: (request, instance) =>
        new URL(request.url).pathname === "/api/runtime/channel"
          ? observeRequest(() => {
              // Read the ID here: the upgrade callback runs inside a database session callback.
              const requestId = currentRequestId()!;
              return runtimeSockets.upgrade(request, (data) =>
                instance.upgrade(request, { data, headers: { [REQUEST_ID_HEADER]: requestId } }),
              );
            }, options.logError)
          : fetch(request),
      error: (error) =>
        observeRequest(() => {
          throw error;
        }, options.logError),
      websocket: runtimeSockets.websocket,
    }),
    {
      workerDone: Promise.resolve(),
    },
  );
  // Cold image pulls and scoped child admission can exceed Bun's default ten-second idle window.
  // Normal Docker launches and scoped child mutations use their own operation deadlines.
  // Other routes retain their existing response timeout policy.
  control.configureDockerLaunchRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureStopRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureScopedMutationRequest = (request) => server.timeout(ingressRequest(request), 0);
  control.configureEventStreamRequest = (request) => server.timeout(ingressRequest(request), 30);
  // Archive validation and encrypted chunk publication have their own bounded deadline.
  configureDockerArchiveTimeout = (request) => server.timeout(ingressRequest(request), 45);
  services.configureAccountDispatch();
  const workers = assembly.planWorkers().start();
  installServerShutdown(server, {
    ...assembly.shutdown,
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
