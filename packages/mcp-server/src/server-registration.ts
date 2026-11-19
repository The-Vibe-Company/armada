import { settleDetachedModalCollections } from "@armada/provider-modal";
import type { Route } from "./http.ts";
import { type defineRoutes, registerRoutes } from "./routes.ts";
import type { ServerServices } from "./server-services.ts";
import { createWorkerServices, extraReaperLanes, type LaneFactory, retentionWorker } from "./server-worker-modules.ts";
import { startServerWorkers } from "./server-workers.ts";

export type MountFactory = (
  services: ServerServices,
  configureDockerArchiveTimeout: (request: Request) => void,
) => readonly Route[];

type BackgroundWorker = { stop(): void; done: Promise<void> };
type WorkerFactory = (services: ServerServices) => (() => BackgroundWorker) | undefined;
type ShutdownHook = (services: ServerServices) => Promise<void> | undefined;
type ShutdownHooks = {
  stopSockets(services: ServerServices): Promise<void>;
  closeDocker: ShutdownHook;
  closeMcp(services: ServerServices): Promise<void>;
};

interface ServerRegistration {
  routes: ReturnType<typeof defineRoutes>[];
  mounts: MountFactory[];
  workers: {
    managed: Map<string, LaneFactory>;
    isolated: Map<string, LaneFactory>;
    background: Map<string, WorkerFactory>;
    beforeListen: ((services: ServerServices) => void)[];
  };
  shutdown: ShutdownHooks;
}

export type ServerModule = (registry: ServerRegistration) => void;

export function registerServer(modules: readonly ServerModule[]) {
  const registry: ServerRegistration = {
    routes: [],
    mounts: [],
    workers: { managed: new Map(), isolated: new Map(), background: new Map(), beforeListen: [] },
    shutdown: {
      stopSockets: async () => {},
      closeDocker: () => undefined,
      closeMcp: async () => {},
    },
  };
  for (const register of modules) register(registry);
  const { mounts, workers, shutdown } = registry;
  return {
    controlRoutes: registerRoutes(registry.routes),
    assembleServer(services: ServerServices) {
      const { options, sql } = services;
      return {
        mounts: (configureDockerArchiveTimeout: (request: Request) => void) =>
          mounts.flatMap((mount) => mount(services, configureDockerArchiveTimeout)),
        startBeforeListen() {
          for (const start of workers.beforeListen) start(services);
        },
        planWorkers() {
          const context = createWorkerServices(services);
          const resolve = (entries: Map<string, LaneFactory>) =>
            Array.from(entries).flatMap(([name, create]) => {
              const lane = create(context);
              return lane ? [{ name, lane }] : [];
            });
          const managed = resolve(workers.managed);
          const isolated = [...resolve(workers.isolated), ...extraReaperLanes(services)];
          const background = Array.from(workers.background).flatMap(([name, prepare]) => {
            const start = prepare(services);
            return start ? [{ name, start }] : [];
          });
          return {
            description: {
              managed: ["sandbox-lifecycle", ...managed.map(({ name }) => name)],
              isolated: isolated.map(({ name, lane }) => ({ name, sweep: lane.isolatedSweep === true })),
              background: background.map(({ name }) => name),
            },
            start() {
              const core = startServerWorkers(
                services.goldenBuilds,
                context.lifecycle,
                options.logError,
                retentionWorker(services),
                managed.map(({ lane }) => lane),
                isolated.map(({ lane }) => lane),
              );
              const started = background.map(({ start }) => start());
              return {
                goldenWorker: core.goldenWorker,
                lifecycleWorker: core.lifecycleWorker,
                done: Promise.all([core.done, ...started.map((worker) => worker.done)]).then(() => {}),
                stop() {
                  core.stop();
                  for (const worker of started) worker.stop();
                },
              };
            },
          };
        },
        shutdown: {
          stopSockets: () => shutdown.stopSockets(services),
          closeDocker: () => shutdown.closeDocker(services),
          closeMcp: () => shutdown.closeMcp(services),
          closePools: () => settleDetachedModalCollections().then(() => sql.close()),
        },
      };
    },
  };
}
