#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { bootDaemon } from "../boot.ts";
import { fold } from "../fold.ts";
import { systemKeychain } from "../keychain.ts";
import { Merges } from "../merge/service.ts";
import { ModelRegistry } from "../models/registry.ts";
import { connectionSecrets } from "../plugins/connection-secrets.ts";
import { type DaemonProject, Projects } from "../projects.ts";
import { startHostedReader } from "../workers/hosted.ts";
import { Workers } from "../workers/service.ts";
import { startWorkerSocket } from "../workers/socket.ts";
import { Account } from "./account.ts";
import { startServer } from "./index.ts";
import { coordinatorModels, loadedModelKinds, modelEnvironment } from "./models.ts";
import { Providers } from "./providers.ts";
import { startReaders } from "./readers.ts";

/** The exit code that asks the desktop shell to start the daemon again (packages/desktop/src/daemon.ts). */
const RESTART_EXIT_CODE = 75;

try {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      projects: { type: "string" },
      port: { type: "string" },
      "static-dir": { type: "string" },
      restartable: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "armadad --database <sqlite-file> --projects <projects.json> [--port <port>] [--static-dir <app-dist>] [--restartable]",
    );
  } else {
    if (!values.database || !values.projects) throw new Error("--database and --projects are required");
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
    let daemon: Awaited<ReturnType<typeof bootDaemon>>;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let workers: Workers;
    let merges: Merges;
    const readerGroups = new Map<string, Awaited<ReturnType<typeof startReaders>>>();
    const controller = new AbortController();
    const refresh = (project: string) => readerGroups.get(project)?.refresh(project) ?? Promise.resolve();
    const keychain = systemKeychain();
    let modelAccess: Awaited<ReturnType<typeof modelEnvironment>>;
    let modelRegistry: ModelRegistry;
    // Boot, dynamic projects and later turns share the catalog's selection.
    async function modelsFor(entries: readonly DaemonProject[]) {
      return coordinatorModels({
        projects: entries,
        store: daemon.store,
        registry: daemon.registry,
        selected: (await modelRegistry.selection()) ?? undefined,
        pluginSelected: modelAccess.pluginSelected,
        pi: modelRegistry,
        onSkipped: (project) =>
          console.error(`Coordinator for ${project} not started: check model plugin configuration and credentials`),
      });
    }
    async function startProject(project: DaemonProject, configure = true) {
      if (configure) await daemon.addProject(project);
      const readers = await startReaders({
        registry: daemon.registry,
        store: daemon.store,
        projects: [project],
        signal: controller.signal,
      });
      readerGroups.set(project.id, readers);
      if (server) {
        const configs = await modelsFor([project]);
        for (const config of configs)
          await server.openProject({
            ...config,
            native: { ...config.native, merges, refresh: () => refresh(project.id) },
          });
      }
    }
    async function stopProject(project: DaemonProject) {
      readerGroups.get(project.id)?.stop();
      readerGroups.delete(project.id);
      await server?.closeProject(project.id);
      daemon.removeProject(project.id);
    }
    const registry = await Projects.open(values.projects, {
      start: startProject,
      stop: stopProject,
      removing: (project, action) => workers.removingProject(project, action),
    });
    const projects = registry.list;
    const account = new Account({ keychain, log: (line) => console.error(line) });
    try {
      void account.refresh();
      modelAccess = await modelEnvironment(process.env, keychain, account.secrets);
      modelRegistry = new ModelRegistry({ keychain, selected: modelAccess.selected ?? null });
      const secrets = connectionSecrets(modelAccess.secrets, keychain);
      const providersFor = (daemon: Awaited<ReturnType<typeof bootDaemon>>) =>
        new Providers({
          configPath: daemon.configPath,
          catalog: daemon.catalog,
          boot: daemon,
          registry: daemon.registry,
          keychain,
          secrets,
        });
      mkdirSync(dirname(values.database), { recursive: true });
      daemon = await bootDaemon({
        databasePath: values.database,
        projects,
        secrets,
        log: { info: (line) => console.error(line), error: (line) => console.error(line) },
      });
      try {
        const coordinators = await modelsFor(projects);
        // Private instance directory avoids stale/active socket unlink races after a crash.
        const workerDirectory = await mkdtemp(join(tmpdir(), "armada-worker-"));
        const workerSocket = join(workerDirectory, "socket");
        workers = new Workers({
          store: daemon.store,
          registry: daemon.registry,
          get projects() {
            return registry.list;
          },
          socketPath: workerSocket,
          account,
          refresh,
        });
        merges = new Merges({
          registry: daemon.registry,
          get projects() {
            return registry.list;
          },
          stop: async (scope, session, key, signal) =>
            workers.tool(
              scope.project,
              "worker.stop",
              {
                ticket: session.ticket,
                reason: "Pull request merged",
              },
              key,
              () => {
                signal.throwIfAborted();
                const current = fold(scope.readEvents()).projects[scope.project]?.sessions.find(
                  (s) => s.ticket === session.ticket,
                );
                if (current?.session !== session.session || current.generation !== session.generation)
                  throw new Error("Worker generation changed");
              },
            ),
        });
        let socket: Awaited<ReturnType<typeof startWorkerSocket>>;
        try {
          socket = await startWorkerSocket(workers, workerSocket);
        } catch (error) {
          await rm(workerDirectory, { recursive: true, force: true });
          throw error;
        }
        let stopping = false;
        try {
          for (const project of projects) await startProject(project, false);
          // First reads get a bounded opportunity to settle before announcing health.
          // Slow initial reads continue in the background; readiness must not cancel them.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            void Promise.all([...readerGroups.values()].map((r) => r.ready)).then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
          server = await startServer({
            store: daemon.store,
            projects,
            projectRegistry: registry,
            port,
            staticDir: values["static-dir"],
            workers,
            account,
            keychain,
            modelRegistry,
            providers: providersFor(daemon),
            resolveCoordinator: async (project) => {
              const config = (await modelsFor(registry.list.filter((p) => p.id === project)))[0];
              return config
                ? { ...config, native: { ...config.native, merges, refresh: () => refresh(project) } }
                : undefined;
            },
            coordinators: coordinators.map((config) => ({
              ...config,
              native: { ...config.native, merges, refresh: () => refresh(config.project) },
            })),
            modelKinds: loadedModelKinds(daemon.registry),
            // The keychain is opened on first use, as the plugins' own secret getter does.
            plugins: {
              configPath: daemon.configPath,
              catalog: daemon.catalog,
              boot: daemon,
              keychain: {
                read: (service, account) => keychain.read(service, account),
                write: (service, account, value) => keychain.write(service, account, value),
              },
            },
            // --restartable: the shell starts a daemon that exits with RESTART_EXIT_CODE again.
            restart: values.restartable
              ? () => {
                  void stop().finally(() => process.exit(RESTART_EXIT_CODE));
                }
              : undefined,
          });
        } catch (error) {
          controller.abort();
          for (const readers of readerGroups.values()) readers.stop();
          await socket.close();
          await rm(workerDirectory, { recursive: true, force: true });
          throw error;
        }
        const hostedReader = startHostedReader({
          store: daemon.store,
          account,
          get projects() {
            return registry.list;
          },
          recover: (project) => workers.recoverHosted(project),
        });
        const workerPoll = setInterval(() => {
          void workers.observeAll();
        }, 1000);
        workerPoll.unref();
        const stop = async () => {
          if (stopping) return;
          stopping = true;
          controller.abort();
          for (const readers of readerGroups.values()) readers.stop();
          clearInterval(workerPoll);
          try {
            await hostedReader.stop();
            await registry.close();
            await server?.close();
            const results = await Promise.allSettled([workers.close(), socket.close()]);
            const failed = results.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          } finally {
            await rm(workerDirectory, { recursive: true, force: true });
            await account.close();
            daemon.close();
          }
        };
        process.once("SIGINT", () => {
          void stop();
        });
        process.once("SIGTERM", () => {
          void stop();
        });
        if (stopping) {
          for (const readers of readerGroups.values()) readers.stop();
        } else {
          // One readiness line for the Electron parent, emitted only after binding.
          console.log(
            JSON.stringify({
              url: server.url,
              wsUrl: server.wsUrl,
              readers: [...readerGroups.values()].flatMap((r) => r.readers),
            }),
          );
        }
      } catch (error) {
        await account.close();
        daemon.close();
        throw error;
      }
    } catch (error) {
      await account.close();
      throw error;
    }
  }
} catch {
  console.error("armadad: could not start; check --database, --projects, --port and --static-dir (see --help)");
  process.exitCode = 1;
}
