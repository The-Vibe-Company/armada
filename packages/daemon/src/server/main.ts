#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { bootDaemon } from "../boot.ts";
import { fold } from "../fold.ts";
import { systemKeychain } from "../keychain.ts";
import { Merges } from "../merge/service.ts";
import { Workers } from "../workers/service.ts";
import { startWorkerSocket } from "../workers/socket.ts";
import { startServer } from "./index.ts";
import { coordinatorModels, loadedModelKinds, modelEnvironment } from "./models.ts";
import { daemonProjectSchema, startReaders } from "./readers.ts";

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
    const catalog = JSON.parse(readFileSync(values.projects, "utf8"));
    if (!Array.isArray(catalog)) throw new Error("--projects must name a JSON array of projects");
    const projects = catalog.map((project) => ({
      ...daemonProjectSchema.parse(project),
      ...(typeof project.checkout === "string" ? { checkout: project.checkout } : {}),
    }));
    mkdirSync(dirname(values.database), { recursive: true });
    const keychain = systemKeychain();
    const modelAccess = await modelEnvironment(process.env, keychain);
    const daemon = await bootDaemon({
      databasePath: values.database,
      secrets: modelAccess.secrets,
      log: { info: (line) => console.error(line), error: (line) => console.error(line) },
    });
    let readers: Awaited<ReturnType<typeof startReaders>> | undefined;
    try {
      const coordinators = coordinatorModels({
        projects,
        store: daemon.store,
        registry: daemon.registry,
        selected: modelAccess.selected,
        onSkipped: (project) =>
          console.error(`Coordinator for ${project} not started: check model plugin configuration and credentials`),
      });
      // Private instance directory avoids stale/active socket unlink races after a crash.
      const workerDirectory = await mkdtemp(join(tmpdir(), "armada-worker-"));
      const workerSocket = join(workerDirectory, "socket");
      const workers = new Workers({
        store: daemon.store,
        registry: daemon.registry,
        projects: projects.flatMap((project) => (project.checkout ? [{ ...project, checkout: project.checkout }] : [])),
        socketPath: workerSocket,
        refresh: (project) => readers?.refresh(project) ?? Promise.resolve(),
      });
      const merges = new Merges({
        registry: daemon.registry,
        projects,
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
      let server: Awaited<ReturnType<typeof startServer>>;
      const controller = new AbortController();
      try {
        readers = await startReaders({
          registry: daemon.registry,
          store: daemon.store,
          projects,
          signal: controller.signal,
        });
        server = await startServer({
          store: daemon.store,
          projects,
          port,
          staticDir: values["static-dir"],
          workers,
          keychain,
          coordinators: coordinators.map((config) => ({
            ...config,
            native: { ...config.native, merges, refresh: () => readers?.refresh(config.project) ?? Promise.resolve() },
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
        readers?.stop();
        await socket.close();
        await rm(workerDirectory, { recursive: true, force: true });
        throw error;
      }
      const workerPoll = setInterval(() => {
        void workers.observeAll();
      }, 1000);
      workerPoll.unref();
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        controller.abort();
        readers?.stop();
        clearInterval(workerPoll);
        try {
          await server.close();
          const results = await Promise.allSettled([workers.close(), socket.close()]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } finally {
          await rm(workerDirectory, { recursive: true, force: true });
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
        readers.stop();
      } else {
        // One readiness line for the Electron parent, emitted only after binding.
        console.log(JSON.stringify({ url: server.url, wsUrl: server.wsUrl, readers: readers.readers }));
      }
    } catch (error) {
      daemon.close();
      throw error;
    }
  }
} catch {
  console.error("armadad: could not start; check --database, --projects, --port and --static-dir (see --help)");
  process.exitCode = 1;
}
