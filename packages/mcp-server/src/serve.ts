import { assertProvider, createSqlAuthStore, oauthOptionsFromEnv } from "@armada/auth";
import {
  createApplicationVault,
  createGoldenAdoption,
  createRoutineScheduler,
  createRoutineService,
  createSkillDefaultsService,
  createSqlVaultStore,
  createTemplateService,
  GoldenBuildJobs,
  GoldenSnapshotRetirements,
  githubAppFromEnv,
  githubInstallationAppFromEnv,
  type LaunchOptions,
  resolveBoatKey,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { boatRuntimeLaunch } from "./boat-runtime-launch.ts";
import { readBoatRuntimeManifest } from "./boat-runtime-manifest.ts";
import { boatRuntimeResume } from "./boat-runtime-resume.ts";
import { authenticateCaller } from "./caller.ts";
import { configFromEnv } from "./config.ts";
import { type ConfiguredControlOptions, handleControlRequest, templateRuntime } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlData } from "./data.ts";
import { retryDatabaseBoot } from "./database-boot.ts";
import { createDatabaseReadiness } from "./database-readiness.ts";
import { requireDatabaseSchema } from "./database-schema.ts";
import { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerHostInstallRoute } from "./docker-host-install.ts";
import { createDockerHostRoutes } from "./docker-host-routes.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { createDockerNormalLaunch } from "./docker-normal-launch.ts";
import { createDockerNormalSend } from "./docker-normal-send.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxControls } from "./docker-sandbox-controls.ts";
import { createDockerSandboxRoutes } from "./docker-sandbox-routes.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { createDockerSnapshots } from "./docker-snapshots.ts";
import { createGitHubAccountApi } from "./github-account.ts";
import { configureBoatGitHub } from "./github-boat.ts";
import { createHandler, providerRegistry, type Route } from "./http.ts";
import { idlePauseDelayMs } from "./idle-pause-policy.ts";
import { invitationsFromEnv, startInvitationWorker } from "./invitations.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { catalogAuthenticationFromEnv } from "./mcp-catalog-client.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { bootstrapBoatMcp } from "./mcp-native.ts";
import { createHistoricalSandboxProviderResolver, createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { modalRuntimeLaunch } from "./modal-runtime-launch.ts";
import { modalRuntimeResume } from "./modal-runtime-resume.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { createOttoApi } from "./otto/api.ts";
import { createOttoRuntime } from "./otto/runtime.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { pruneServerRetention } from "./retention-maintenance.ts";
import { observeRoutinePrompt } from "./routine-observer.ts";
import { startRoutineWorker } from "./routine-worker.ts";
import { createRuntimeArtifactRoute } from "./runtime-artifacts.ts";
import { createRuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeEvents } from "./runtime-events.ts";
import { createRuntimeFollowup } from "./runtime-followup.ts";
import { createRuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeIdle } from "./runtime-idle.ts";
import { createRuntimeMcp } from "./runtime-mcp.ts";
import { createRuntimeModelAccess } from "./runtime-model-access.ts";
import { createRuntimeNativeAuth } from "./runtime-native-auth.ts";
import { createRuntimeProgress } from "./runtime-progress.ts";
import { createRuntimeResume } from "./runtime-resume.ts";
import { createRuntimeServing } from "./runtime-serving.ts";
import { createRuntimeSockets, type RuntimeSocketData } from "./runtime-sockets.ts";
import { orchestratorScopedMcpUrl } from "./sandbox-access-scoped-gateway.ts";
import { createSandboxAccessServices } from "./sandbox-access-services.ts";
import { createSandboxAccountChange } from "./sandbox-account-change.ts";
import { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { createSandboxBillingAccount } from "./sandbox-billing-account.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { startServerWorkers } from "./server-workers.ts";
import { bunSql } from "./sql.ts";
import { createSubscriptionMigration } from "./subscription-migration.ts";

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
  const idleDelayMs = idlePauseDelayMs(env);
  const launch: LaunchOptions = { extensionHeadroomSeconds: config.sandboxExtensionHeadroomSeconds };
  const catalogAuthentication = catalogAuthenticationFromEnv(
    env,
    config.encryptionKey,
    config.dashboardUrl,
    config.development,
  );
  await catalogAuthentication("slack"); // Reject invalid deployment ciphertext before serving.
  const sql = bunSql(config.databaseUrl, config.databasePoolMax);
  const runtimeEnrolments = createRuntimeEnrolments(sql, config.encryptionKey);
  const runtimeCommands = createRuntimeCommands(runtimeEnrolments, config.encryptionKey);
  const runtimeCheckpoint = createRuntimeCheckpoint(sql, config.encryptionKey, runtimeCommands, {
    docker: env.ARMADA_DOCKER_HOSTS === "1" && env.ARMADA_DOCKER_PLACEMENT === "1",
  });
  let subscriptionMigration: ReturnType<typeof createSubscriptionMigration>;
  const modelAuth = createModelAuthOwnership(sql, config.encryptionKey, undefined, undefined, {
    origin: config.publicUrl,
    prepareAccount: (actor, id, version) => subscriptionMigration.prepareAccount(actor, id, version),
    prepareTurn: (provider, id, caller) => subscriptionMigration.prepareTurn(provider, id, caller),
  });
  const store = createSqlVaultStore(sql);
  const authStore = createSqlAuthStore(sql);
  // Isolate and cancel Otto queries: timed-out reads must not exhaust the control API pool.
  const ottoSql = env.ARMADA_OTTO_ORG_ID ? bunSql(config.databaseUrl, 2, 1_500) : undefined;
  const otto = createOttoRuntime(ottoSql ?? sql, env);
  const githubApp = githubAppFromEnv(env);
  const runtimeGitHub = githubApp
    ? createRuntimeGitHub({
        sql,
        key: config.encryptionKey,
        origin: config.publicUrl,
        github: { store, app: githubApp, encryptionKey: config.encryptionKey },
        commands: runtimeCommands,
      })
    : undefined;
  const sandboxArmadaAccess = createSandboxArmadaAccess({
    sql,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
  });
  const data = createSqlData(sql);
  const templates = createTemplateService(sql, config.encryptionKey);
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
  const runtimeMcp = createRuntimeMcp({
    sql,
    key: config.encryptionKey,
    origin: config.publicUrl,
    commands: runtimeCommands,
    probe: (userId, orgId, connectionId) => mcp.controlBroker.status({ userId, orgId, connectionId }),
  });
  try {
    await retryDatabaseBoot(async () => {
      await requireDatabaseSchema(sql);
      await mcp.drainInvalidations();
    }, options.logError ?? console.error);
  } catch (error) {
    await mcp.close();
    await Promise.all([sql.close(), ottoSql?.close()]);
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
  const runtimeProviderFor = createRuntimeServing(sql, config.encryptionKey);
  const providers = providerRegistry({
    runtimeProviderFor,
    vault: store,
    encryptionKey: config.encryptionKey,
    providerFor,
    modalProviderFor,
    modalTokensFor: modal.modalTokensFor,
  });
  subscriptionMigration = createSubscriptionMigration(
    sql,
    createHistoricalSandboxProviderResolver(providers),
    (provider, id, caller, quiesced) => modelAuth.capture(provider, id, caller, quiesced),
    modelAuth.broker!,
  );
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
  const imageBoatManifest = `/opt/armada/runtime-manifests/${process.arch}.json`;
  const deployed = await readBoatRuntimeManifest(
    env.ARMADA_BOAT_RUNTIME_MANIFEST ?? imageBoatManifest,
    config.boatAgentPath,
  );
  const runtimeLaunch = deployed
    ? boatRuntimeLaunch({
        sql,
        encryptionKey: config.encryptionKey,
        serverUrl: config.publicUrl,
        ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
        manifest: deployed.manifest,
        architecture: deployed.architecture,
        modelAuth,
      })
    : undefined;
  if (config.boatAgentPath === "runtime") {
    if (!runtimeLaunch) throw Error("Boat runtime default requires installed runtime artifacts.");
    launch.boatRuntimeDefault = {
      policy: runtimeLaunch,
      credentials: launchCredentials(store, config.encryptionKey, undefined, modelAuth),
      connections: runtimeMcp.connections,
      provider: async (actor, golden) =>
        createBoatProvider({
          apiKey: (
            await resolveBoatKey(store, config.encryptionKey, {
              userId: actor.userId,
              orgId: actor.orgId,
              visibility: golden.visibility,
            })
          ).key,
        }),
    };
  }
  let modalRuntimePolicy: ReturnType<typeof modalRuntimeLaunch> | undefined;
  if (env.ARMADA_MODAL_DIALOUT === "1") {
    if (!env.ARMADA_MODAL_RUNTIME_MANIFEST) throw Error("Modal runtime manifest required.");
    const manifest = await Bun.file(env.ARMADA_MODAL_RUNTIME_MANIFEST).json();
    if (
      manifest?.protocol !== 1 ||
      manifest.platform !== "linux" ||
      manifest.libc !== "glibc" ||
      !["x64", "arm64"].includes(manifest.architecture)
    )
      throw Error("Invalid Modal runtime manifest.");
    modalRuntimePolicy = modalRuntimeLaunch({
      sql,
      encryptionKey: config.encryptionKey,
      serverUrl: config.publicUrl,
      manifest,
      architecture: manifest.architecture,
    });
  }
  // Docker placement is a separate, explicit API preview. Host polling remains
  // enabled independently so disabling new placement does not strand cleanup.
  const dockerCredentials = launchCredentials(store, config.encryptionKey, undefined, modelAuth);
  const dockerEnabled = env.ARMADA_DOCKER_HOSTS === "1" && env.ARMADA_DOCKER_PLACEMENT === "1";
  let dockerBootstrap: ReturnType<typeof createDockerBootstrapService> | undefined;
  if (dockerEnabled) {
    if (!env.ARMADA_DOCKER_RUNTIME_MANIFEST) throw Error("Docker runtime manifest required.");
    const dockerManifest = await Bun.file(env.ARMADA_DOCKER_RUNTIME_MANIFEST).json();
    if (
      dockerManifest?.protocol !== 1 ||
      dockerManifest.platform !== "linux" ||
      dockerManifest.libc !== "glibc" ||
      !["x64", "arm64"].includes(dockerManifest.architecture)
    )
      throw Error("Invalid Docker runtime deployment manifest.");
    dockerBootstrap = createDockerBootstrapService(sql, config.encryptionKey, {
      enabled: true,
      serverUrl: config.publicUrl,
      manifest: dockerManifest,
      architecture: dockerManifest.architecture,
      // Plain-image launches resolve only the model account, not GitHub or host credentials.
      credentials: dockerCredentials,
      modelAuth,
    });
  }
  const modalRuntimeHostFor = async (
    target: import("@armada/core").ProviderTarget,
    caller: import("./caller.ts").Caller,
  ) => {
    if (!target.modal) throw Error("Modal binding required.");
    const tokens = await modal.modalTokensFor(target, caller);
    return (await modal.modalProviderFor({ tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret }, target.modal, {
      target,
      caller,
      credentialScope: tokens.scope,
    })) as import("@armada/provider-modal").ModalProvider;
  };
  const boatResume = runtimeLaunch
    ? boatRuntimeResume({ sql, vault: store, key: config.encryptionKey, policy: runtimeLaunch, modelAuth })
    : undefined;
  const modalResume = modalRuntimePolicy
    ? modalRuntimeResume({
        sql,
        vault: store,
        key: config.encryptionKey,
        policy: modalRuntimePolicy,
        hostFor: modalRuntimeHostFor,
      })
    : undefined;
  const runtimeResume = createRuntimeResume(
    sql,
    config.encryptionKey,
    runtimeCommands,
    boatResume || modalResume
      ? (caller, sandbox) => {
          const prepare = sandbox.provider === "modal" ? modalResume : boatResume;
          if (!prepare) throw new VaultError("unavailable", "Runtime resume policy unavailable.");
          return prepare(caller, sandbox);
        }
      : undefined,
    runtimeMcp.prepare,
    runtimeGitHub?.prepareLaunch,
  );
  const runtimeSend = createRuntimeFollowup(
    sql,
    config.encryptionKey,
    runtimeCommands,
    runtimeMcp.prepare,
    runtimeResume,
  );
  const dockerControls =
    env.ARMADA_DOCKER_HOSTS === "1"
      ? createDockerSandboxControls(sql, config.encryptionKey, {
          prepareMcp: runtimeMcp.prepare,
          ...(runtimeGitHub ? { prepareSnapshotGitHub: runtimeGitHub.prepareLaunch } : {}),
          ...(dockerBootstrap ? { resume: dockerBootstrap } : {}),
          ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
          send: createDockerNormalSend(sql, config.encryptionKey, {
            prepareMcp: runtimeMcp.prepare,
            ...(runtimeGitHub ? { prepareSnapshotGitHub: runtimeGitHub.prepareLaunch } : {}),
            enabled: dockerEnabled && Boolean(dockerBootstrap),
            ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
          }),
        })
      : undefined;
  const dockerLaunchEnabled = dockerEnabled && Boolean(dockerBootstrap);
  const dockerLaunch =
    env.ARMADA_DOCKER_HOSTS === "1"
      ? createDockerNormalLaunch(sql, config.encryptionKey, {
          mcp: runtimeMcp,
          enabled: dockerLaunchEnabled,
          deferLaunch: true,
          ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
          credentials: dockerCredentials,
          ...(dockerBootstrap ? { bootstrap: dockerBootstrap } : {}),
        })
      : undefined;
  const control: ConfiguredControlOptions = {
    ...(dockerControls ? { dockerControls } : {}),
    ...(dockerLaunch ? { dockerLaunch } : {}),
    docker: {
      hosts: env.ARMADA_DOCKER_HOSTS === "1",
      placement: dockerEnabled,
      normalApi: Boolean(dockerControls),
      normalLaunch: dockerLaunchEnabled,
      normalSend: dockerLaunchEnabled,
      normalResume: dockerLaunchEnabled,
    },
    runtimeSend,
    runtimeCheckpoint,
    runtimeResume,
    ...(runtimeGitHub ? { runtimeGitHub } : {}),
    runtimeMcp,
    ...(modalRuntimePolicy
      ? {
          modalRuntimeLaunch: modalRuntimePolicy,
          modalRuntimeHostFor,
        }
      : {}),
    ...(runtimeLaunch
      ? { boatRuntimeLaunch: runtimeLaunch, runtimeHostFor: (apiKey: string) => createBoatProvider({ apiKey }) }
      : {}),
    launch,
    publicUrl: config.publicUrl,
    modelAuth,
    sandboxBillingAccount: createSandboxBillingAccount(sql),
    credentialBindingRecovery: createSandboxAccountChange(
      sql,
      dockerCredentials,
      createCredentialBindingRecovery(sql, config.encryptionKey),
    ),
    modelUsage: createModelUsageApi(sql),
    goldenRetirements,
    invitations: invitationsFromEnv(sql, env),
    templates,
    skillDefaults: createSkillDefaultsService(sql),
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
    storedProviderFor: modal.storedProviderFor,
    logs: async (caller, sandboxId) => {
      const scoped = data(caller);
      const sandbox = await scoped.sandboxes.get(sandboxId);
      if (!sandbox) throw new Error("No such sandbox.");
      return {
        provider: await (sandbox.provider === "modal"
          ? modal.storedProviderFor(sandbox, caller)
          : providers.resolve(sandbox, caller)),
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
  ]) as NamedLaunchCredentials;
  const sandboxAccessContext = {
    extensionHeadroomSeconds: config.sandboxExtensionHeadroomSeconds,
    sql,
    providers,
    credentials,
    encryptionKey: config.encryptionKey,
    connections: mcp.connections,
    publicUrl: config.publicUrl,
    scopedMcpUrl: orchestratorScopedMcpUrl(config.publicUrl),
  };
  const delegatedAccess = createSandboxAccessServices(sandboxAccessContext);
  const runtimeEvents = createRuntimeEvents(
    runtimeEnrolments,
    config.encryptionKey,
    createRuntimeNativeAuth(sql, config.encryptionKey),
  );
  const runtimeSockets = createRuntimeSockets(runtimeEnrolments, runtimeCommands);
  const handler = createHandler({
    ...(dockerControls ? { dockerControls } : {}),
    runtimeSend,
    runtimeCheckpoint,
    runtimeResume,
    ...(runtimeGitHub ? { runtimeGitHub } : {}),
    ready: createDatabaseReadiness(sql),
    idlePauseDelayMs: idleDelayMs,
    ...(env.RAILWAY_GIT_COMMIT_SHA ? { commitSha: env.RAILWAY_GIT_COMMIT_SHA } : {}),
    runtimeProviderFor,
    launch,
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
    skillDefaults: createSkillDefaultsService(sql),
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
    storedProviderFor: modal.storedProviderFor,
    modalTokensFor: modal.modalTokensFor,
    goldenTarget: modal.goldenTarget,
    routes: [
      ...(env.ARMADA_DOCKER_HOSTS === "1"
        ? [
            createDockerSandboxRoutes(
              {
                sandboxes: createDockerSandboxService(sql, config.encryptionKey, { enabled: dockerEnabled }),
                ...(dockerBootstrap ? { bootstrap: dockerBootstrap } : {}),
                runtime: createDockerRuntimeLifecycle(sql, config.encryptionKey, { enabled: dockerEnabled }),
              },
              (request) =>
                authenticateCaller(request.headers.get("authorization"), {
                  store: authStore,
                  supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
                  now: new Date(),
                }),
            ),
            createDockerHostRoutes(
              createDockerHostStore(sql, config.encryptionKey),
              (request) =>
                authenticateCaller(request.headers.get("authorization"), {
                  store: authStore,
                  supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
                  now: new Date(),
                }),
              {
                placement: dockerLaunchEnabled,
                publicUrl: config.publicUrl,
                snapshots: createDockerSnapshots(sql, config.encryptionKey, {
                  enabled: dockerLaunchEnabled,
                  github: { store, app: githubApp, encryptionKey: config.encryptionKey },
                  installationApp: githubInstallationAppFromEnv(env),
                }),
              },
            ),
          ]
        : []),
      ...(otto
        ? [
            otto.route,
            createOttoApi(
              ottoSql ?? sql,
              otto.scope,
              (request) =>
                authenticateCaller(request.headers.get("authorization"), {
                  store: authStore,
                  supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
                  now: new Date(),
                }),
              undefined,
              config.encryptionKey,
            ),
          ]
        : []),
      createDockerHostInstallRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR, config.publicUrl),
      createRuntimeArtifactRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR),
      runtimeEnrolments.route,
      createRuntimeProgress(runtimeEnrolments),
      createRuntimeModelAccess(sql, config.encryptionKey, modelAuth.broker),
      runtimeEvents.route,
      runtimeCommands.route,
      ...(runtimeGitHub ? [runtimeGitHub.route] : []),
      delegatedAccess.scopedToolsRoute,
      ...(modelAuth.broker ? [modelAuth.broker.route] : []),
      modal.route,
      mcp.route,
      (request) => handleControlRequest(request, control),
      ...(options.routes ?? []),
    ],
    ...(options.logError ? { log: options.logError } : {}),
  });
  mcp.startBackground();
  dockerLaunch?.startBackground();
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
  const server = Object.assign(
    Bun.serve<RuntimeSocketData>({
      port: config.port,
      hostname: "0.0.0.0",
      // Keep Bun's 128 MiB ingress budget explicit: MCP prompts/tool arguments have no
      // smaller aggregate cap. Control JSON (128 KiB) and broker (1 KiB) are bounded per route.
      maxRequestBodySize: 128 * 1024 * 1024,
      fetch: (request, instance) =>
        new URL(request.url).pathname === "/api/runtime/channel"
          ? runtimeSockets.upgrade(request, (data) => instance.upgrade(request, { data }))
          : fetch(request),
      websocket: runtimeSockets.websocket,
    }),
    {
      workerDone: Promise.resolve(),
    },
  );
  // Cold image pulls/bootstrap can exceed Bun's default ten-second idle window.
  // Only authenticated normal Docker launches opt out; their service deadline
  // remains bounded, and other providers/routes keep their existing timeouts.
  control.configureDockerLaunchRequest = (request) => server.timeout(request, 0);
  const lifecycle = createSandboxLifecycle(sql, createMcpSandboxProviderResolver(sql, providers), {
    delayMs: idleDelayMs,
  });
  const workers = startServerWorkers(
    goldenBuilds,
    lifecycle,
    options.logError,
    goldenRetirements,
    () => pruneServerRetention(sql, control.applicationVault, new Date()),
    [
      delegatedAccess.childWorker,
      createRuntimeIdle(sql, config.encryptionKey, runtimeCheckpoint, {
        delayMs: idleDelayMs,
        ...(dockerBootstrap
          ? {
              dockerStop: (actor, id, requestId) =>
                createDockerHostStore(sql, config.encryptionKey).enqueueSandbox(actor, id, {
                  operation: "stop",
                  requestId,
                  idleCheckpointRequest: requestId,
                }),
            }
          : {}),
      }),
    ],
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
      return observeRoutinePrompt(caller, turn, {
        ...(control.dockerControls ? { docker: control.dockerControls } : {}),
        get: (id) => data(caller).sandboxes.get(id),
        provider: (sandbox) => providers.resolve(sandbox, caller),
      });
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
      const authorize = async (tx: Sql = sql) => {
        const grant = (
          await tx.query(
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
        beforeDockerReserve: async (tx: Sql, id: string) => {
          await authorize(tx);
          await admission.beforeFork(tx);
          await runtime.options?.beforeFork?.(id);
        },
        beforeDockerStart: () => authorize(),
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
  const ottoWorker = otto?.start();
  const allWorkersDone = Promise.all([workers.done, invitationWorker?.done, routineWorker.done, ottoWorker?.done]).then(
    () => {},
  );
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
    ottoWorker?.stop();
    // Requests may still use the gateway and SQL while finishing a launch.
    // Drain handlers and POST response streams; idle GET SSE needs
    // MCP close to finish. SQL stays alive until the native HTTP drain completes.
    const socketsStopped = runtimeSockets.stop();
    const stopped = stop(closeActiveConnections);
    shutdown = Promise.all([
      allWorkersDone,
      dockerLaunch?.close(),
      socketsStopped,
      (async () => {
        while (requests.size) await Promise.allSettled([...requests]);
      })(),
    ])
      .then(() => mcp.close())
      .then(() => stopped)
      .then(() => Promise.all([sql.close(), ottoSql?.close()]))
      .then(() => {});
    server.workerDone = shutdown;
    return shutdown;
  };
  // Expose the tracked task for hosts that gracefully drain before process termination.
  Object.assign(server, { goldenWorker: workers.goldenWorker, lifecycleWorker: workers.lifecycleWorker });
  server.workerDone = allWorkersDone;
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
