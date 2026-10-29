#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { bootDaemon } from "../boot.ts";
import { readPluginSecret } from "../plugins/keychain.ts";
import { Workers } from "../workers/service.ts";
import { startWorkerSocket } from "../workers/socket.ts";
import { startServer } from "./index.ts";
import { daemonProjectSchema, startReaders } from "./readers.ts";

try {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      projects: { type: "string" },
      port: { type: "string" },
      "static-dir": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "armadad --database <sqlite-file> --projects <projects.json> [--port <port>] [--static-dir <app-dist>]",
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
    const daemon = await bootDaemon({
      databasePath: values.database,
      secrets: { get: readPluginSecret },
      log: { info: (line) => console.error(line), error: (line) => console.error(line) },
    });
    try {
      // Private instance directory avoids stale/active socket unlink races after a crash.
      const workerDirectory = await mkdtemp(join(tmpdir(), "armada-worker-"));
      const workerSocket = join(workerDirectory, "socket");
      const workers = new Workers({
        store: daemon.store,
        registry: daemon.registry,
        projects: projects.flatMap((project) => (project.checkout ? [{ ...project, checkout: project.checkout }] : [])),
        socketPath: workerSocket,
      });
      let socket: Awaited<ReturnType<typeof startWorkerSocket>>;
      try {
        socket = await startWorkerSocket(workers, workerSocket);
      } catch (error) {
        await rm(workerDirectory, { recursive: true, force: true });
        throw error;
      }
      let server: Awaited<ReturnType<typeof startServer>>;
      try {
        server = await startServer({ store: daemon.store, projects, port, staticDir: values["static-dir"], workers });
      } catch (error) {
        await socket.close();
        await rm(workerDirectory, { recursive: true, force: true });
        throw error;
      }
      const workerPoll = setInterval(() => {
        void workers.observeAll();
      }, 1000);
      workerPoll.unref();
      let readers: Awaited<ReturnType<typeof startReaders>> | undefined;
      const controller = new AbortController();
      let stopping = false;
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
      try {
        readers = await startReaders({ store: daemon.store, projects, signal: controller.signal });
      } catch (error) {
        await stop();
        throw error;
      }
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
