#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { bootDaemon } from "../boot.ts";
import { readPluginSecret } from "../plugins/keychain.ts";
import { startServer } from "./index.ts";

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
    const projects = JSON.parse(readFileSync(values.projects, "utf8"));
    if (!Array.isArray(projects)) throw new Error("--projects must name a JSON array of projects");
    mkdirSync(dirname(values.database), { recursive: true });
    const daemon = await bootDaemon({
      databasePath: values.database,
      secrets: { get: readPluginSecret },
      log: { info: (line) => console.error(line), error: (line) => console.error(line) },
    });
    try {
      const server = await startServer({ store: daemon.store, projects, port, staticDir: values["static-dir"] });
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await server.close();
        daemon.close();
      };
      process.once("SIGINT", () => {
        void stop();
      });
      process.once("SIGTERM", () => {
        void stop();
      });
      // One readiness line for the Electron parent, emitted only after binding.
      console.log(JSON.stringify({ url: server.url, wsUrl: server.wsUrl }));
    } catch (error) {
      daemon.close();
      throw error;
    }
  }
} catch {
  console.error("armadad: could not start; check --database, --projects, --port and --static-dir (see --help)");
  process.exitCode = 1;
}
