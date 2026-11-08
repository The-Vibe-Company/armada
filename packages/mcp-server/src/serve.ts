import { createServiceStore, oauthOptionsFromEnv } from "@armada/auth";
import { createSqlVaultStore, type Sql } from "@armada/core";
import { createBoatProvider } from "@armada/provider-boat";
import { configFromEnv } from "./config.ts";
import { type ControlOptions, handleControlRequest } from "./control.ts";
import { createSqlData } from "./data.ts";
import { createHandler, type Route } from "./http.ts";

/** `Sql` over Bun's Postgres client, for the privileged `ARMADA_DATABASE_URL` connection. */
export function bunSql(url: string): Sql {
  const sql = new Bun.SQL(url);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
      return { rows: Array.from(rows) };
    },
  };
}

/**
 * Starts the server from the environment (see `configFromEnv`). The control API (`/api/v1/`, for the
 * CLI) and `/mcp` share one database connection. Logs no token, key or request body.
 */
export async function startServer(
  env: Record<string, string | undefined>,
  options: { routes?: readonly Route[]; log?: (line: string) => void } = {},
) {
  const config = configFromEnv(env);
  const sql = bunSql(config.databaseUrl);
  const store = createSqlVaultStore(sql);
  const authStore = createServiceStore({ env: { ...env, SUPABASE_URL: config.supabaseUrl } });
  const control: ControlOptions = {
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    store,
    encryptionKey: config.encryptionKey,
  };
  const handler = createHandler({
    publicUrl: config.publicUrl,
    oauth: oauthOptionsFromEnv({ store: authStore, env: { ...env, ARMADA_PUBLIC_URL: config.publicUrl } }),
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    data: createSqlData(sql),
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor: (apiKey) => createBoatProvider({ apiKey }),
    routes: [(request) => handleControlRequest(request, control), ...(options.routes ?? [])],
  });
  const server = Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: handler });
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
