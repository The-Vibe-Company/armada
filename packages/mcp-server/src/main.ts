#!/usr/bin/env bun
import { startServer } from "./serve.ts";
import { ServerConfigError } from "./server-config-error.ts";
import { installShutdownHandlers } from "./shutdown.ts";
import { readStartupConfiguration } from "./startup-configuration.ts";

const checkingConfig = process.argv[2] === "--check-config";
try {
  if (checkingConfig) {
    const input: unknown = await Bun.stdin.json();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.values(input).some((value) => value !== null && typeof value !== "string")
    )
      throw new ServerConfigError("Expected a deployment environment object on stdin.");
    const env = new Proxy({ ...process.env, ...input } as Record<string, string | undefined>, {
      get(target, name: string) {
        const value = target[name];
        if (value === null) throw new ServerConfigError(`Cannot validate sealed Railway variable ${name}.`);
        return value;
      },
    });
    await readStartupConfiguration(env);
  } else {
    const server = await startServer(process.env);
    installShutdownHandlers(server);
  }
} catch (error) {
  const message =
    checkingConfig && !(error instanceof ServerConfigError)
      ? "Could not validate the deployment environment."
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`armada-server: ${message}`);
  process.exitCode = 2;
}
