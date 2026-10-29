#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { bootDaemon } from "../boot.ts";
import { systemKeychain } from "../keychain.ts";
import { readPluginSecret } from "../plugins/keychain.ts";
import { startServer } from "./index.ts";
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
    const projects = catalog.map((project) => daemonProjectSchema.parse(project));
    mkdirSync(dirname(values.database), { recursive: true });
    const daemon = await bootDaemon({
      databasePath: values.database,
      secrets: { get: readPluginSecret },
      log: { info: (line) => console.error(line), error: (line) => console.error(line) },
    });
    try {
      let stopping = false;
      const server = await startServer({
        store: daemon.store,
        projects,
        port,
        staticDir: values["static-dir"],
        // The keychain is opened on first use, as the plugins' own secret getter does.
        plugins: {
          configPath: daemon.configPath,
          catalog: daemon.catalog,
          boot: daemon,
          keychain: {
            read: (service, account) => systemKeychain().read(service, account),
            write: (service, account, value) => systemKeychain().write(service, account, value),
          },
        },
        // --restartable: the shell starts a daemon that exits with RESTART_EXIT_CODE again.
        restart: values.restartable
          ? () => {
              void stop().finally(() => process.exit(RESTART_EXIT_CODE));
            }
          : undefined,
      });
      let readers: Awaited<ReturnType<typeof startReaders>> | undefined;
      const controller = new AbortController();
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        controller.abort();
        readers?.stop();
        await server.close();
        daemon.close();
      };
      process.once("SIGINT", () => {
        void stop();
      });
      process.once("SIGTERM", () => {
        void stop();
      });
      try {
        readers = await startReaders({ registry: daemon.registry, projects, signal: controller.signal });
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
