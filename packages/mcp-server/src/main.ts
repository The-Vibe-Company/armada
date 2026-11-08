#!/usr/bin/env bun
import { startServer } from "./serve.ts";

try {
  await startServer(process.env);
} catch (error) {
  console.error(`armada-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
