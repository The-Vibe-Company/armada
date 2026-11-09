import { assertProvider, createSqlAuthStore, oauthOptionsFromEnv } from "@armada/auth";
import {
  createGoldenAdoption,
  createSqlVaultStore,
  GoldenBuildJobs,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { configFromEnv } from "./config.ts";
import { type ConfiguredControlOptions, handleControlRequest } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlData } from "./data.ts";
import { createGitHubAccountApi } from "./github-account.ts";
import { createHandler, providerRegistry, type Route } from "./http.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { bootstrapBoatMcp } from "./mcp-native.ts";
import { createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { startServerWorkers } from "./server-workers.ts";
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
  const catalogAuthentication = catalogAuthenticationFromEnv(
    env,
    config.encryptionKey,
    config.dashboardUrl,
    config.development,
  );
  await catalogAuthentication("slack"); // Reject invalid deployment ciphertext before serving.
  const sql = bunSql(config.databaseUrl);
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  const githubApp = githubAppFromEnv(env);
  const data = createSqlData(sql);
  const mcp = createMcpHttpIntegration({
    catalogAuthentication,
    sql,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    dashboardUrl: config.dashboardUrl,
    development: config.development,
    providerForSandbox: (id) => createMcpSandboxProviderResolver(sql, providers)(id),
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
  });
  await mcp.drainInvalidations();
  const providerFor = (apiKey: string, caller?: { userId: string; orgId: string }) => {
    const provider = createBoatProvider({
      apiKey,
      beforeResume: async (provider, id) => {
        if (!caller) throw Error("Native resume requires trusted Armada caller scope.");
        return mcp.beforeResume(provider, id, caller);
      },
      beforePrompt: async (provider, id) => {
        if (!caller) throw Error("Native prompt requires trusted Armada caller scope.");
        await mcp.beforePrompt(provider, id, caller);
      },
      beforeSnapshot: mcp.beforeSnapshot,
    });
    provider.configureMcp = ({ sandboxId, configuration }) => bootstrapBoatMcp(provider, sandboxId, configuration);
    return provider;
  };
  const providerMetadata = createProviderMetadata({
    sql,
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor: (apiKey) => createBoatProvider({ apiKey }),
  });
  const modal = await createModalIntegration({
    sql,
    vault: store,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    github: { store, app: githubApp },
    beforePrompt: mcp.beforePrompt,
  });
  const providers = providerRegistry({
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor,
    modalProviderFor: modal.modalProviderFor,
    modalTokensFor: modal.modalTokensFor,
  });
  const goldenAdoption = createGoldenAdoption(sql);

  const goldenBuilds = new GoldenBuildJobs({
    sql,
    encryptionKey: config.encryptionKey,
    service: {
      github: { store, encryptionKey: config.encryptionKey, app: githubApp },
      installationApp: githubInstallationAppFromEnv(env),
    },
    provider: async (actor, _visibility, target) => providers.resolve(target, { userId: actor.userId }),
  });
  const control: ConfiguredControlOptions = {
    credentialBindingRecovery: createCredentialBindingRecovery(sql, config.encryptionKey),
    mcp: { registry: mcp.registry, broker: mcp.controlBroker },
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    store,
    encryptionKey: config.encryptionKey,
    data,
    connections: mcp.connections,
    vault: store,
    github: { app: githubApp },
    githubAccount: createGitHubAccountApi({
      sql,
      app: githubApp,
      dashboardUrl: config.dashboardUrl,
      development: env.NODE_ENV === "development",
      encryptionKey: config.encryptionKey,
      ...(env.GITHUB_APP_SLUG ? { slug: env.GITHUB_APP_SLUG } : {}),
    }),
    providerFor,
    providerMetadata,
    providers,
    goldenTarget: modal.goldenTarget,
    goldenBuilds,
    goldenAdoption,
    logs: async (caller, sandboxId) => {
      const scoped = data(caller);
      const sandbox = await scoped.sandboxes.get(sandboxId);
      if (!sandbox) throw new Error("No such sandbox.");
      return {
        provider: await providers.resolve(sandbox, caller),
        providerSandboxId: sandbox.providerSandboxId,
      };
    },
  };
  const handler = createHandler({
    publicUrl: config.publicUrl,
    loginProviders: (env.ARMADA_AUTH_PROVIDERS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map(assertProvider),
    oauth: oauthOptionsFromEnv({ store: authStore, env: { ...env, ARMADA_PUBLIC_URL: config.publicUrl } }),
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    data,
    connections: mcp.connections,
    vault: store,
    encryptionKey: config.encryptionKey,
    github: { store, app: githubApp },
    goldenBuilds,
    goldenAdoption,
    providerFor,
    providerMetadata,
    modalProviderFor: modal.modalProviderFor,
    modalTokensFor: modal.modalTokensFor,
    goldenTarget: modal.goldenTarget,
    routes: [modal.route, mcp.route, (request) => handleControlRequest(request, control), ...(options.routes ?? [])],
    ...(options.logError ? { log: options.logError } : {}),
  });
  const server = Object.assign(Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch: handler }), {
    workerDone: Promise.resolve(),
  });
  const lifecycle = createSandboxLifecycle(sql, createMcpSandboxProviderResolver(sql, providers));
  const workers = startServerWorkers(goldenBuilds, lifecycle, options.logError);
  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    workers.stop();
    const closed = mcp.close();
    const stopped = stop(closeActiveConnections);
    server.workerDone = Promise.all([workers.done, closed, stopped]).then(() => {});
    return stopped;
  };
  // Expose the tracked task for hosts that gracefully drain before process termination.
  Object.assign(server, { goldenWorker: workers.goldenWorker, lifecycleWorker: workers.lifecycleWorker });
  server.workerDone = workers.done;
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
