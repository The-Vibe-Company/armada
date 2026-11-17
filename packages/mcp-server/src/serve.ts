import { assertProvider, createSqlAuthStore, oauthOptionsFromEnv } from "@armada/auth";
import {
  createApplicationVault,
  createGoldenAdoption,
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
  VaultError,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { repairHistoricalTurnModels } from "./account-model-upgrade.ts";
import { createAccountTurnQueue } from "./account-turn-queue.ts";
import { boatRuntimeLaunch } from "./boat-runtime-launch.ts";
import { readBoatRuntimeManifest } from "./boat-runtime-manifest.ts";
import { boatRuntimeResume } from "./boat-runtime-resume.ts";
import { authenticateCaller } from "./caller.ts";
import { configFromEnv } from "./config.ts";
import { type ConfiguredControlOptions, dispatchControlCommand, handleControlRequest } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlCredentialList } from "./credential-list-sql.ts";
import { createScopedSandboxData, createSqlData } from "./data.ts";
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
import { createSqlGoldenList } from "./golden-list.ts";
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
import { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import { pruneServerRetention } from "./retention-maintenance.ts";
import { startRoutineWorker } from "./routine-worker.ts";
import { createRuntimeArtifactRoute, createRuntimeArtifactSetRoute } from "./runtime-artifacts.ts";
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
import { createFinishedDockerCleanup } from "./sandbox-finish.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { createServerRequestDrain } from "./server-request-drain.ts";
import { createServerRoutineScheduler } from "./server-routines.ts";
import { installServerShutdown } from "./server-shutdown.ts";
import { startServerWorkers } from "./server-workers.ts";
import sourceIdentity from "./source-identity.json";
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
      await repairHistoricalTurnModels(sql, config.encryptionKey);
      await mcp.drainInvalidations();
    }, options.logError ?? console.error);
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
      resumeRefused: (provider, id) => modelAuth.releaseProviderCapacity(provider, id),
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
    resumeRefused: (provider, id) => modelAuth.releaseProviderCapacity(provider, id),
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
  if (config.boatAgentPath === "runtime" && !runtimeLaunch)
    throw Error("Boat runtime default requires installed runtime artifacts.");
  if (runtimeLaunch) {
    launch.boatEndpointRuntime = {
      policy: runtimeLaunch,
      credentials: launchCredentials(store, config.encryptionKey, undefined, modelAuth, { store, app: githubApp }),
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
    if (config.boatAgentPath === "runtime") launch.boatRuntimeDefault = launch.boatEndpointRuntime;
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
      ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
      modelAuth,
    });
  }
  // Docker placement is a separate, explicit API preview. Host polling remains
  // enabled independently so disabling new placement does not strand cleanup.
  const dockerCredentials = launchCredentials(store, config.encryptionKey, undefined, modelAuth, {
    store,
    app: githubApp,
  });
  const dockerEnabled = env.ARMADA_DOCKER_HOSTS === "1" && env.ARMADA_DOCKER_PLACEMENT === "1";
  let dockerBootstrap: ReturnType<typeof createDockerBootstrapService> | undefined;
  let dockerArtifactSet: ReturnType<typeof createRuntimeArtifactSetRoute> | undefined;
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
    dockerArtifactSet = createRuntimeArtifactSetRoute(dockerManifest);
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
  if (config.modalAgentPath === "runtime") {
    if (!modalRuntimePolicy)
      throw Error("Modal runtime default requires the explicit runtime policy; no native fallback.");
    launch.modalRuntimeDefault = {
      policy: modalRuntimePolicy,
      credentials: launchCredentials(store, config.encryptionKey, undefined, modelAuth),
      connections: runtimeMcp.connections,
      provider: (actor, golden) =>
        modalRuntimeHostFor(
          { ...golden, runtimeTransport: "dialout" },
          {
            userId: actor.userId,
            orgs: [{ orgId: actor.orgId, role: actor.role }],
            via: "service",
          },
        ),
    };
  }
  const boatResume = runtimeLaunch
    ? boatRuntimeResume({ sql, vault: store, key: config.encryptionKey, policy: runtimeLaunch, modelAuth })
    : undefined;
  const modalResume = modalRuntimePolicy
    ? modalRuntimeResume({
        sql,
        vault: store,
        key: config.encryptionKey,
        policy: modalRuntimePolicy,
        modelAuth,
        hostFor: modalRuntimeHostFor,
      })
    : undefined;
  const runtimeResume = createRuntimeResume(
    sql,
    config.encryptionKey,
    runtimeCommands,
    boatResume || modalResume
      ? (caller, sandbox) => {
          const prepare = { boat: boatResume, modal: modalResume }[sandbox.provider];
          if (!prepare) throw new VaultError("unavailable", "Runtime resume policy unavailable.");
          return prepare(caller, sandbox);
        }
      : undefined,
    runtimeMcp.prepare,
    runtimeGitHub?.prepareLaunch,
  );
  const accountTurns = createAccountTurnQueue(sql, config.encryptionKey);
  const runtimeSend = createRuntimeFollowup(
    sql,
    config.encryptionKey,
    runtimeCommands,
    runtimeMcp.prepare,
    runtimeResume,
  );
  const makeDockerControls = (dispatchQueued: boolean) =>
    createDockerSandboxControls(sql, config.encryptionKey, {
      prepareMcp: runtimeMcp.prepare,
      ...(runtimeGitHub ? { prepareSnapshotGitHub: runtimeGitHub.prepareLaunch } : {}),
      ...(dockerBootstrap ? { resume: dockerBootstrap } : {}),
      ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
      send: createDockerNormalSend(sql, config.encryptionKey, {
        dispatchQueued,
        prepareMcp: runtimeMcp.prepare,
        ...(runtimeGitHub ? { prepareSnapshotGitHub: runtimeGitHub.prepareLaunch } : {}),
        enabled: dockerEnabled && Boolean(dockerBootstrap),
        ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
      }),
    });
  const dockerControls = env.ARMADA_DOCKER_HOSTS === "1" ? makeDockerControls(false) : undefined;
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
  const logProviders = { boat: providers.resolve.bind(providers), modal: modal.storedProviderFor };
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
    accountTurns,
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
    listGoldenRecords: createSqlGoldenList(sql, store),
    listCredentialMetadata: createSqlCredentialList(sql, store),
    scopedSandboxData: createScopedSandboxData(sql, store),
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
        provider: await logProviders[sandbox.provider](sandbox, caller),
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
  const commitSha = sourceIdentity.commit ?? env.RAILWAY_GIT_COMMIT_SHA;
  const handler = createHandler({
    ...(dockerControls ? { dockerControls } : {}),
    runtimeSend,
    accountTurns,
    runtimeCheckpoint,
    runtimeResume,
    ...(runtimeGitHub ? { runtimeGitHub } : {}),
    ...(control.sandboxBillingAccount ? { sandboxBillingAccount: control.sandboxBillingAccount } : {}),
    ready: createDatabaseReadiness(sql),
    idlePauseDelayMs: idleDelayMs,
    ...(commitSha ? { commitSha } : {}),
    runtimeProviderFor,
    ordinaryLaunchReceipts: createOrdinaryLaunchReceipts(sql),
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
      createDockerHostInstallRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR, config.publicUrl),
      createRuntimeArtifactRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR),
      ...(dockerArtifactSet ? [dockerArtifactSet] : []),
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
  const requestDrain = createServerRequestDrain(handler);
  const { fetch, requests } = requestDrain;
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
  const { accountTurns: _queue, ...unqueuedControl } = control;
  accountTurns.setDispatch((caller, input) =>
    dispatchControlCommand(
      "sandbox/send",
      caller,
      { ...input },
      { ...unqueuedControl, ...(dockerControls ? { dockerControls: makeDockerControls(true) } : {}) },
    ),
  );
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
      createFinishedDockerCleanup(sql, config.encryptionKey),
      accountTurns,
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
  const routineScheduler = createServerRoutineScheduler({ sql, control, templates, providers, data });
  const routineWorker = startRoutineWorker(routineScheduler, options.logError);
  const allWorkersDone = Promise.all([workers.done, invitationWorker?.done, routineWorker.done]).then(() => {});
  installServerShutdown(server, {
    beginDrain: () => {
      requestDrain.beginDrain();
      workers.stop();
      invitationWorker?.stop();
      routineWorker.stop();
    },
    workersDone: allWorkersDone,
    stopSockets: () => runtimeSockets.stop(),
    closeDocker: () => dockerLaunch?.close(),
    requests,
    closeMcp: () => mcp.close(),
    closePools: () => sql.close(),
  });
  // Expose the tracked task for hosts that gracefully drain before process termination.
  Object.assign(server, { goldenWorker: workers.goldenWorker, lifecycleWorker: workers.lifecycleWorker });
  server.workerDone = allWorkersDone;
  (options.log ?? console.log)(`armada serve: listening on port ${server.port}, public URL ${config.publicUrl}`);
  return server;
}
