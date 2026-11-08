import { createSqlAuthStore, oauthOptionsFromEnv } from "@armada/auth";
import { createSqlVaultStore, githubAppFromEnv } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { configFromEnv } from "./config.ts";
import { type ControlOptions, handleControlRequest } from "./control.ts";
import { createSqlData } from "./data.ts";
import { createHandler, type Route } from "./http.ts";
import { bunSql } from "./sql.ts";

export { bunSql };

/**
 * Starts the server from the environment (see `configFromEnv`). The control API (`/api/v1/`, for the
 * CLI), the token and membership lookups of `/mcp` and its tools all share one database connection,
 * so no second credential (a PostgREST key) can fail on its own. Logs no token, key or request body.
 */
export async function startServer(
  env: Record<string, string | undefined>,
  options: {
    routes?: readonly Route[];
    log?: (line: string) => void;
    /** Failures the server absorbs (an unavailable auth lookup, a tool that failed inside). Redacted. Defaults to stderr. */
    logError?: (line: string) => void;
  } = {},
) {
  const config = configFromEnv(env);
  const sql = bunSql(config.databaseUrl);
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  const githubApp = githubAppFromEnv(env);
  const control: ControlOptions = {
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    store,
    encryptionKey: config.encryptionKey,
    github: { app: githubApp },
  };
  const handler = createHandler({
    publicUrl: config.publicUrl,
    oauth: oauthOptionsFromEnv({ store: authStore, env: { ...env, ARMADA_PUBLIC_URL: config.publicUrl } }),
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    data: createSqlData(sql),
    vault: store,
    encryptionKey: config.encryptionKey,
    github: { store, app: githubApp },
    providerFor: (apiKey) => createBoatProvider({ apiKey }),
    routes: [(request) => handleControlRequest(request, control), ...(options.routes ?? [])],
    ...(options.logError ? { log: options.logError } : {}),
  });
  const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: handler });
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
