import { assertProvider, createSqlAuthStore, oauthOptionsFromEnv } from "@armada/auth";
import type { ProviderRegistry, Sql } from "@armada/core/server";
import {
  createApplicationVault,
  createGoldenAdoption,
  createRoutineScheduler,
  createRoutineService,
  createSqlVaultStore,
  createTemplateService,
  GoldenBuildJobs,
  GoldenSnapshotRetirements,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
  promptOutcome,
  VaultError,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { configFromEnv } from "./config.ts";
import { type ConfiguredControlOptions, handleControlRequest, templateRuntime } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlData } from "./data.ts";
import { retryDatabaseBoot } from "./database-boot.ts";
import { createDatabaseReadiness } from "./database-readiness.ts";
import { createGitHubAccountApi } from "./github-account.ts";
import { configureBoatGitHub } from "./github-boat.ts";
import { createHandler, providerRegistry, type Route } from "./http.ts";
import { invitationsFromEnv, startInvitationWorker } from "./invitations.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { bootstrapBoatMcp } from "./mcp-native.ts";
import { createHistoricalSandboxProviderResolver, createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import type { NamedOrchestratorCredentials } from "./orchestrator-backend-resolver.ts";
import type { createOrchestratorServices } from "./orchestrator-composition.ts";
import { orchestratorDiagnosticLog } from "./orchestrator-diagnostics.ts";
import { createProductionOrchestrators } from "./orchestrator-production.ts";
import { orchestratorScopedMcpUrl } from "./orchestrator-scoped-gateway.ts";
import type { OrchestratorServiceBundle } from "./orchestrator-services.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { pruneServerRetention } from "./retention-maintenance.ts";
import { startRoutineWorker } from "./routine-worker.ts";
import { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
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
    /** Trusted embedding override; otherwise the explicit server pair setting composes Modal Codex. */
    orchestrators?: (context: {
      sql: Sql;
      providers: ProviderRegistry;
      credentials: NamedOrchestratorCredentials;
      encryptionKey: string | undefined;
      connections: NonNullable<ConfiguredControlOptions["connections"]>;
      managedConnections: NonNullable<ConfiguredControlOptions["connections"]>;
      publicUrl: string;
      scopedMcpUrl: string;
    }) =>
      | Promise<
          Pick<ReturnType<typeof createOrchestratorServices>, "runtime" | "lifecycle"> | OrchestratorServiceBundle
        >
      | OrchestratorServiceBundle;
    routes?: readonly Route[];
    log?: (line: string) => void;
    /** Failures the server absorbs (an unavailable auth lookup, a tool that failed inside). Redacted. Defaults to stderr. */
    logError?: (line: string) => void;
  } = {},
) {
  const config = configFromEnv(env);
  const launch = { extensionHeadroomSeconds: config.sandboxExtensionHeadroomSeconds };
  const catalogAuthentication = catalogAuthenticationFromEnv(
    env,
    config.encryptionKey,
    config.dashboardUrl,
    config.development,
  );
  await catalogAuthentication("slack"); // Reject invalid deployment ciphertext before serving.
  const sql = bunSql(config.databaseUrl, config.databasePoolMax);
  const modelAuth = createModelAuthOwnership(sql, config.encryptionKey, undefined, undefined, (tx, id) =>
    createHistoricalSandboxProviderResolver(providers)(tx, id),
  );
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  const githubApp = githubAppFromEnv(env);
  const sandboxArmadaAccess = createSandboxArmadaAccess({
    sql,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
  });
  const data = createSqlData(sql);
  const templates = createTemplateService(sql);
  const mcp = createMcpHttpIntegration({
    prepareReadableVariables: templates.prepare,
    deferBackground: true,
    githubRuntimeEnabled: config.githubRuntimeEnabled,
    githubLegacyAutoPrepareEnabled: config.githubLegacyAutoPrepareEnabled,
    github: { store, app: githubApp, encryptionKey: config.encryptionKey },
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
  try {
    await retryDatabaseBoot(() => mcp.drainInvalidations(), options.logError ?? console.error);
  } catch (error) {
    await mcp.close();
    await sql.close();
    throw error;
  }
  const providerFor = (apiKey: string, caller?: { userId: string; orgId: string }) => {
    const provider = createBoatProvider({
      apiKey,
      sanitizeEvents: async (provider, id, events) => {
        if (!caller) throw Error("Native events require trusted Armada caller scope.");
        return modelAuth.redactEvents(provider, id, caller, events);
      },
      beforeStop: async (provider, id) => {
        if (caller) await modelAuth.beforeStop(provider, id, caller);
      },
      afterPrompt: async (provider, id) => {
        if (caller) await modelAuth.capture(provider, id, caller);
      },
      beforeResume: async (provider, id) => {
        if (!caller) throw Error("Native resume requires trusted Armada caller scope.");
        await modelAuth.beforeResume(provider, id, caller);
        return mcp.beforeResume(provider, id, caller);
      },
      beforePrompt: async (provider, id) => {
        if (!caller) throw Error("Native prompt requires trusted Armada caller scope.");
        await mcp.beforePrompt(provider, id, caller);
        await modelAuth.beforePrompt(provider, id, caller);
        await sandboxArmadaAccess.beforePrompt(provider, id);
      },
      beforeSnapshot: async (provider, id) => {
        if (caller) await modelAuth.capture(provider, id, caller);
        await sandboxArmadaAccess.beforeSnapshot(provider, id);
        await mcp.beforeSnapshot(provider, id);
      },
    });
    if (config.githubRuntimeEnabled)
      provider.configureGitHub = ({ sandboxId, configuration }) =>
        configureBoatGitHub(provider, sandboxId, configuration);
    provider.configureMcp = ({ sandboxId, configuration }) => bootstrapBoatMcp(provider, sandboxId, configuration);
    return sandboxArmadaAccess.wrap(provider);
  };
  const providerMetadata = createProviderMetadata({
    sql,
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor: (apiKey) => createBoatProvider({ apiKey }),
  });
  const modal = await createModalIntegration({
    beforeResume: (provider, id, caller) => modelAuth.beforeResume(provider, id, caller),
    sql,
    vault: store,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    github: { store, app: githubApp },
    beforePrompt: async (provider, id, caller) => {
      await mcp.beforePrompt(provider, id, caller);
      await sandboxArmadaAccess.beforePrompt(provider, id);
    },
  });
  const modalProviderFor: typeof modal.modalProviderFor = async (...args) =>
    sandboxArmadaAccess.wrap(await modal.modalProviderFor(...args));
  const providers = providerRegistry({
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor,
    modalProviderFor,
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
  const goldenRetirements = new GoldenSnapshotRetirements({
    sql,
    encryptionKey: config.encryptionKey,
    provider: (actor, target) => providers.resolve(target, { userId: actor.userId }),
  });
  const control: ConfiguredControlOptions = {
    launch,
    orchestratorPairs: config.orchestratorPairs,
    publicUrl: config.publicUrl,
    modelAuth,
    credentialBindingRecovery: createCredentialBindingRecovery(sql, config.encryptionKey, modelAuth),
    modelUsage: createModelUsageApi(sql),
    goldenRetirements,
    invitations: invitationsFromEnv(sql, env),
    templates,
    routines: createRoutineService(sql),
    applicationVault: createApplicationVault(sql, config.encryptionKey),
    mcp: { registry: mcp.registry, broker: mcp.controlBroker },
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    store,
    encryptionKey: config.encryptionKey,
    data,
    connections: mcp.connections,
    sandboxArmadaAccess,
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
  // Actual604 exposes the same ownership object on control.modelAuth. Reflect keeps
  // pre-producer deployments type-safe; no second ownership/redaction registry is created.
  const credentials = Reflect.apply(launchCredentials, undefined, [
    store,
    config.encryptionKey,
    { store, app: githubApp },
    Reflect.get(control, "modelAuth"),
  ]) as NamedOrchestratorCredentials;
  const orchestratorContext = {
    extensionHeadroomSeconds: config.sandboxExtensionHeadroomSeconds,
    sql,
    providers,
    credentials,
    encryptionKey: config.encryptionKey,
    connections: mcp.connections,
    managedConnections: mcp.managedConnections,
    publicUrl: config.publicUrl,
    scopedMcpUrl: orchestratorScopedMcpUrl(config.publicUrl),
  };
  const orchestrators = options.orchestrators
    ? await options.orchestrators(orchestratorContext)
    : createProductionOrchestrators({
        ...orchestratorContext,
        encryptionKey: config.encryptionKey,
        requestedPairs: config.orchestratorPairs,
        skillRevision: config.orchestratorSkillRevision,
        diagnosticLog: orchestratorDiagnosticLog({
          info: options.log ?? console.info,
          warn: console.warn,
          error: options.logError ?? console.error,
        }),
      });
  if (orchestrators) control.orchestrators = orchestrators.runtime;
  const handler = createHandler({
    ready: createDatabaseReadiness(sql),
    launch,
    orchestratorPairs: config.orchestratorPairs,
    ...(orchestrators ? { orchestrators: orchestrators.runtime } : {}),
    modelAuth,
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
    templates,
    ...(control.applicationVault ? { applicationVault: control.applicationVault } : {}),
    connections: mcp.connections,
    vault: store,
    encryptionKey: config.encryptionKey,
    github: { store, app: githubApp },
    goldenBuilds,
    goldenAdoption,
    providerFor,
    providerMetadata,
    modalProviderFor,
    modalTokensFor: modal.modalTokensFor,
    goldenTarget: modal.goldenTarget,
    routes: [
      ...(orchestrators && "scopedToolsRoute" in orchestrators
        ? [
            orchestrators.scopedToolsRoute,
            orchestrators.ownerLifecycleRoute({
              authStore,
              supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
            }),
          ]
        : []),
      modal.route,
      mcp.route,
      (request) => handleControlRequest(request, control),
      ...(options.routes ?? []),
    ],
    ...(options.logError ? { log: options.logError } : {}),
  });
  mcp.startBackground();
  let draining = false;
  const requests = new Set<Promise<unknown>>();
  const fetch = (request: Request) => {
    if (draining)
      return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "5" } });
    const pending = handler(request).then((response) => {
      // Gateway POST tools use SSE responses: the handler can return before the
      // admitted tool finishes. GET notification streams instead end at MCP close.
      if (request.method !== "POST" || !response.body) return response;
      const reader = response.body.getReader();
      const finished = Promise.withResolvers<void>();
      requests.add(finished.promise);
      void finished.promise.then(() => requests.delete(finished.promise));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              finished.resolve();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            finished.resolve();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finished.resolve();
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
    return pending;
  };
  const server = Object.assign(Bun.serve({ port: config.port, hostname: "0.0.0.0", fetch }), {
    workerDone: Promise.resolve(),
  });
  const lifecycle = createSandboxLifecycle(sql, createMcpSandboxProviderResolver(sql, providers));
  const workers = startServerWorkers(
    goldenBuilds,
    lifecycle,
    options.logError,
    goldenRetirements,
    () => pruneServerRetention(sql, control.applicationVault, new Date()),
    orchestrators
      ? [
          orchestrators.runtime.createWorker,
          ...("lifecycle" in orchestrators
            ? [orchestrators.lifecycle]
            : [orchestrators.lifecycleWorker, orchestrators.childWorker, orchestrators.eventWorker]),
        ]
      : [],
  );
  const invitationWorker =
    env.ARMADA_INVITATION_MAIL === "supabase" && control.invitations
      ? startInvitationWorker(control.invitations)
      : undefined;
  const routineScheduler = createRoutineScheduler(sql, {
    observe: async (actor, turn) => {
      const orgId = actor.orgs[0]?.orgId;
      const member = (
        await sql.query<{ role: "admin" | "member" }>(
          "select role from public.members where org_id=$1 and user_id=$2",
          [orgId, actor.userId],
        )
      ).rows[0];
      if (!member) return "unknown";
      const caller = { userId: actor.userId, orgs: [{ orgId: orgId!, role: member.role }], via: "service" as const };
      const sandbox = await data(caller).sandboxes.get(turn.sandboxId);
      if (!sandbox || sandbox.status === "deleted") return "unknown";
      const provider = await providers.resolve(sandbox, caller);
      const result = await promptOutcome(provider, {
        sandboxId: sandbox.providerSandboxId,
        promptId: turn.promptId,
        ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
      });
      // Never persist a provider message or a later turn's state in routine history.
      return result.state;
    },
    launch: async (actor, input, admission) => {
      // Re-read the persisted execution owner's role, never impersonate the editing admin.
      const orgId = input.org as string;
      const member = (
        await sql.query<{ role: "admin" | "member" }>(
          "select role from public.members where org_id=$1 and user_id=$2",
          [orgId, actor.userId],
        )
      ).rows[0];
      if (!member) throw new Error("Routine owner unavailable.");
      const caller = { userId: actor.userId, orgs: [{ orgId, role: member.role }], via: "service" as const };
      const runtime = templateRuntime(control, caller);
      if (!runtime) throw new VaultError("unavailable", "Routine launch runtime unavailable.");
      const authorize = async () => {
        const grant = (
          await sql.query(
            `select m.user_id from public.routine_runs run
          join public.routines r on r.id=run.routine_id
          join public.members m on m.org_id=r.org_id and m.user_id=run.owner_id
          where run.request_key=$1 and run.owner_id=$2 and run.org_id=$3
          and (r.scope='personal' or m.role='admin')`,
            [input.requestKey, actor.userId, orgId],
          )
        ).rows[0];
        if (!grant) throw new VaultError("forbidden", "Routine owner authorization changed.");
      };
      return templates.command(caller, "launch", input, {
        ...runtime,
        options: {
          ...runtime.options,
          beforeFork: async (id) => {
            await authorize();
            await runtime.options?.beforeFork?.(id);
            await admission.beforeFork();
          },
          beforeStart: async (provider, sandbox) => {
            await authorize();
            await runtime.options?.beforeStart?.(provider, sandbox);
          },
        },
      });
    },
  });
  const routineWorker = startRoutineWorker(routineScheduler, options.logError);
  const allWorkersDone = Promise.all([workers.done, invitationWorker?.done, routineWorker.done]).then(() => {});
  const stop = server.stop.bind(server);
  let shutdown: Promise<void> | undefined;
  server.stop = (closeActiveConnections?: boolean) => {
    if (shutdown) {
      if (closeActiveConnections) void stop(true);
      return shutdown;
    }
    draining = true;
    workers.stop();
    invitationWorker?.stop();
    routineWorker.stop();
    // Requests may still use the gateway and SQL while finishing a launch.
    // Drain handlers and POST response streams; idle GET SSE needs
    // MCP close to finish. SQL stays alive until the native HTTP drain completes.
    const stopped = stop(closeActiveConnections);
    shutdown = Promise.all([
      allWorkersDone,
      (async () => {
        while (requests.size) await Promise.allSettled([...requests]);
      })(),
    ])
      .then(() => mcp.close())
      .then(() => stopped)
      .then(() => sql.close());
    server.workerDone = shutdown;
    return shutdown;
  };
  // Expose the tracked task for hosts that gracefully drain before process termination.
  Object.assign(server, { goldenWorker: workers.goldenWorker, lifecycleWorker: workers.lifecycleWorker });
  server.workerDone = allWorkersDone;
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
