#!/usr/bin/env bun
import { startServer } from "./serve.ts";
import { installShutdownHandlers } from "./shutdown.ts";

try {
  const server = await startServer(process.env);
  installShutdownHandlers(server);
} catch (error) {
  console.error(`armada-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
