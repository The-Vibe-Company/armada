import { createSqlAuthStore } from "@armada/auth";
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
import { repairHistoricalTurnModels } from "./account-model-upgrade.ts";
import { createAccountTurnQueue } from "./account-turn-queue.ts";
import { boatRuntimeLaunch } from "./boat-runtime-launch.ts";
import { boatRuntimeResume } from "./boat-runtime-resume.ts";
import { type ConfiguredControlOptions, createQueuedSandboxDispatch } from "./control.ts";
import { createCredentialBindingRecovery } from "./credential-binding-recovery.ts";
import { createSqlCredentialList } from "./credential-list-sql.ts";
import { createScopedSandboxData, createSqlData } from "./data.ts";
import { retryDatabaseBoot } from "./database-boot.ts";
import { createDatabaseReadiness } from "./database-readiness.ts";
import { requireDatabaseSchema } from "./database-schema.ts";
import { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerNormalLaunch } from "./docker-normal-launch.ts";
import { createDockerNormalSend } from "./docker-normal-send.ts";
import { createDockerOutputReader } from "./docker-outputs.ts";
import { createDockerSandboxControls } from "./docker-sandbox-controls.ts";
import { createEventFeed } from "./event-feed.ts";
import { createGitHubAccountApi } from "./github-account.ts";
import { configureBoatGitHub } from "./github-boat.ts";
import { createSqlGoldenList } from "./golden-list.ts";
import { type HandlerOptions, providerRegistry, type Route } from "./http.ts";
import { Invitations } from "./invitations.ts";
import { createJobsStore } from "./jobs/store.ts";
import { createLangfuse } from "./langfuse.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { bootstrapBoatMcp } from "./mcp-native.ts";
import { createHistoricalSandboxProviderResolver, createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalArtifactCache } from "./modal-artifact-cache.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { modalRuntimeLaunch } from "./modal-runtime-launch.ts";
import { modalRuntimeResume } from "./modal-runtime-resume.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import { createOutboundWebhooks } from "./outbound-webhooks.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import type { ProviderReaperSource } from "./provider-reaper.ts";
import { createRuntimeArtifactSetRoute } from "./runtime-artifacts.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "./runtime-checkpoint.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeEvents } from "./runtime-events.ts";
import { createRuntimeFollowup } from "./runtime-followup.ts";
import { createRuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeMcp } from "./runtime-mcp.ts";
import { createRuntimeNativeAuth } from "./runtime-native-auth.ts";
import { createRuntimeResume } from "./runtime-resume.ts";
import { createRuntimeServing } from "./runtime-serving.ts";
import { createRuntimeSockets } from "./runtime-sockets.ts";
import { orchestratorScopedMcpUrl } from "./sandbox-access-scoped-gateway.ts";
import { createSandboxAccessServices } from "./sandbox-access-services.ts";
import { createSandboxAccountChange } from "./sandbox-account-change.ts";
import { createSandboxArmadaAccess } from "./sandbox-armada-access.ts";
import { createSandboxBillingAccount } from "./sandbox-billing-account.ts";
import { createSandboxOutputs } from "./sandbox-outputs.ts";
import sourceIdentity from "./source-identity.json";
import { bunSql } from "./sql.ts";
import { readStartupConfiguration } from "./startup-configuration.ts";
import { createSubscriptionMigration } from "./subscription-migration.ts";

export interface ServerOptions {
  routes?: readonly Route[];
  providerReaperSources?: readonly ProviderReaperSource[];
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export async function createServerServices(env: Record<string, string | undefined>, options: ServerOptions) {
  const {
    config,
    sql,
    scriptedModel,
    idleDelayMs,
    catalogAuthentication,
    invitationMail,
    boat,
    modalRuntime,
    dockerManifest,
  } = await readStartupConfiguration(env);
  const dockerEnabled = dockerManifest !== undefined;
  const boatDeploymentId = env.ARMADA_BOAT_DEPLOYMENT_ID?.trim();
  const boatInventory = boatDeploymentId ? { deploymentId: boatDeploymentId } : {};
  const runtimeHostFor = (apiKey: string) => createObservedBoatProvider({ apiKey, ...boatInventory });
  const launch: LaunchOptions = { extensionHeadroomSeconds: config.sandboxExtensionHeadroomSeconds };
  const jobs = createJobsStore(sql, config.encryptionKey);
  const webhooks = createOutboundWebhooks(sql, config.encryptionKey, config.dashboardUrl);
  const runtimeEnrolments = createRuntimeEnrolments(sql, config.encryptionKey);
  const runtimeCommands = createRuntimeCommands(runtimeEnrolments, config.encryptionKey);
  const runtimeCheckpoint = createRuntimeCheckpoint(sql, config.encryptionKey, runtimeCommands, {
    docker: dockerEnabled,
  });
  const runtimeStopCheckpoint = createRuntimeStopCheckpoint(sql, runtimeCheckpoint);
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
    commands: runtimeCommands,
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
  const providerFor = (apiKey: string, caller?: { userId: string; orgId: string }, sandboxId?: string) => {
    const provider = createObservedBoatProvider(
      {
        apiKey,
        ...boatInventory,
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
      },
      sandboxId,
    );
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
    providerFor: (apiKey) => createObservedBoatProvider({ apiKey }),
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
    launchStageSql: sql,
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
  const runtimeLaunch = boat
    ? boatRuntimeLaunch({
        sql,
        encryptionKey: config.encryptionKey,
        serverUrl: config.publicUrl,
        ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
        manifest: boat.manifest,
        architecture: boat.architecture,
        modelAuth,
      })
    : undefined;
  if (runtimeLaunch) {
    launch.boatEndpointRuntime = {
      policy: runtimeLaunch,
      credentials: launchCredentials(store, config.encryptionKey, undefined, modelAuth, { store, app: githubApp }),
      connections: runtimeMcp.connections,
      provider: async (actor, golden) =>
        runtimeHostFor(
          (
            await resolveBoatKey(store, config.encryptionKey, {
              userId: actor.userId,
              orgId: actor.orgId,
              visibility: golden.visibility,
            })
          ).key,
        ),
    };
    if (config.boatAgentPath === "runtime") launch.boatRuntimeDefault = launch.boatEndpointRuntime;
  }
  let warmModalArtifacts: ReturnType<typeof createModalArtifactCache> | undefined;
  let modalRuntimePolicy: ReturnType<typeof modalRuntimeLaunch> | undefined;
  if (modalRuntime) {
    const { manifest, artifactDir } = modalRuntime;
    warmModalArtifacts = createModalArtifactCache(manifest, artifactDir);
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
  const dockerCredentials = launchCredentials(store, config.encryptionKey, undefined, modelAuth, {
    store,
    app: githubApp,
  });
  let dockerBootstrap: ReturnType<typeof createDockerBootstrapService> | undefined;
  let dockerArtifactSet: ReturnType<typeof createRuntimeArtifactSetRoute> | undefined;
  if (dockerManifest) {
    dockerArtifactSet = createRuntimeArtifactSetRoute(dockerManifest);
    dockerBootstrap = createDockerBootstrapService(sql, config.encryptionKey, {
      enabled: true,
      serverUrl: config.publicUrl,
      manifest: dockerManifest,
      architecture: dockerManifest.architecture,
      credentials: { ...dockerCredentials, admit: dockerCredentials.admitExistingSandbox },
      modelAuth,
    });
  }
  if (warmModalArtifacts) {
    const logError = options.logError ?? console.error;
    const startupSql = bunSql(config.databaseUrl, 4, 5_000);
    try {
      await modal.warmRegisteredArtifactCaches(warmModalArtifacts, startupSql, logError);
    } catch {
      logError("Could not list registered Modal Apps for startup warming.");
    } finally {
      await startupSql.close();
    }
  }
  const modalRuntimeHostFor = async (
    target: import("@armada/core").ProviderTarget,
    caller: import("./caller.ts").Caller,
  ) => {
    if (!target.modal) throw Error("Modal binding required.");
    const tokens = await modal.modalTokensFor(target, caller);
    return (await modal.modalProviderFor(
      { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
      target.modal,
      { target, caller, credentialScope: tokens.scope },
      false,
      (binding) => warmModalArtifacts?.beginWarming(binding, options.logError ?? console.error),
    )) as import("@armada/provider-modal").ModalProvider;
  };
  if (config.modalAgentPath === "runtime" && modalRuntimePolicy) {
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
    sandboxArmadaAccess.restoreEnrolled,
  );
  const accountTurns = createAccountTurnQueue(sql, config.encryptionKey);
  const runtimeSend = createRuntimeFollowup(
    sql,
    config.encryptionKey,
    runtimeCommands,
    runtimeMcp.prepare,
    runtimeResume,
    sandboxArmadaAccess.restoreEnrolled,
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
  const ordinaryLaunchReceipts = createOrdinaryLaunchReceipts(sql);
  const control: ConfiguredControlOptions = {
    ordinaryLaunchReceipts,
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
    runtimeStopCheckpoint,
    runtimeResume,
    ...(runtimeGitHub ? { runtimeGitHub } : {}),
    runtimeMcp,
    ...(modalRuntimePolicy
      ? {
          modalRuntimeLaunch: modalRuntimePolicy,
          modalRuntimeHostFor,
        }
      : {}),
    ...(runtimeLaunch ? { boatRuntimeLaunch: runtimeLaunch, runtimeHostFor } : {}),
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
    invitations: new Invitations(sql, config.encryptionKey, invitationMail),
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
    runtimeSend,
    runtimeCheckpoint,
    runtimePlacements: { modal: launch.modalRuntimeDefault },
    encryptionKey: config.encryptionKey,
    connections: mcp.connections,
    publicUrl: config.publicUrl,
    scopedMcpUrl: orchestratorScopedMcpUrl(config.publicUrl),
  };
  const delegatedAccess = createSandboxAccessServices(sandboxAccessContext);
  control.eventFeed = createEventFeed(sql, delegatedAccess.authority);
  const nativeHistoryFor = createHistoricalSandboxProviderResolver({
    resolve: (target, caller) => logProviders[target.provider](target, caller),
  });
  const langfuse = createLangfuse(sql, config.encryptionKey, (id, generation) => nativeHistoryFor(sql, id, generation));
  const runtimeEvents = createRuntimeEvents(
    runtimeEnrolments,
    config.encryptionKey,
    createRuntimeNativeAuth(sql, config.encryptionKey),
  );
  const runtimeSockets = createRuntimeSockets(runtimeEnrolments, runtimeCommands);
  const commitSha = sourceIdentity.commit ?? env.RAILWAY_GIT_COMMIT_SHA;
  const outputs = createSandboxOutputs(
    sql,
    config.encryptionKey,
    createMcpSandboxProviderResolver(sql, providers, { terminalObservation: true }),
    ...(config.encryptionKey ? [createDockerOutputReader(sql, config.encryptionKey)] : []),
  );
  const handlerOptions: Omit<HandlerOptions, "routes"> = {
    launchDiscovery: control,
    readOutputSnapshot: outputs.readSnapshot,
    ...(dockerControls ? { dockerControls } : {}),
    runtimeSend,
    runtimeStopCheckpoint,
    accountTurns,
    ...(control.sandboxBillingAccount ? { sandboxBillingAccount: control.sandboxBillingAccount } : {}),
    ready: createDatabaseReadiness(sql),
    launchStageSql: sql,
    idlePauseDelayMs: idleDelayMs,
    ...(commitSha ? { commitSha } : {}),
    runtimeProviderFor,
    ordinaryLaunchReceipts,
    launch,
    modelAuth,
    publicUrl: config.publicUrl,
    loginProviders: config.loginProviders,
    oauth: {
      store: authStore,
      fetch,
      now: () => new Date(),
      supabaseUrl: config.supabaseUrl,
      anonKey: config.anonKey,
      authSecret: config.authSecret,
      publicUrl: config.publicUrl,
    },
    authStore,
    supabase: { supabaseUrl: config.supabaseUrl, anonKey: config.anonKey },
    data,
    skillDefaults: createSkillDefaultsService(sql),
    connections: mcp.connections,
    vault: store,
    encryptionKey: config.encryptionKey,
    github: { store, app: githubApp },
    providerFor,
    modalProviderFor,
    storedProviderFor: modal.storedProviderFor,
    modalTokensFor: modal.modalTokensFor,
    ...(options.logError ? { log: options.logError } : {}),
  };

  return {
    env,
    options,
    config,
    sql,
    handlerOptions,
    scriptedModel,
    jobs,
    store,
    authStore,
    githubApp,
    control,
    outputs,
    webhooks,
    dockerEnabled,
    dockerBootstrap,
    dockerLaunchEnabled,
    dockerLaunch,
    dockerArtifactSet,
    runtimeEnrolments,
    runtimeCommands,
    runtimeEvents,
    runtimeGitHub,
    runtimeSockets,
    langfuse,
    delegatedAccess,
    modelAuth,
    modal,
    modalArtifactCache: warmModalArtifacts,
    mcp,
    goldenBuilds,
    goldenRetirements,
    providers,
    idleDelayMs,
    accountTurns,
    runtimeCheckpoint,
    templates,
    data,
    configureAccountDispatch: () => {
      accountTurns.setDispatch(
        createQueuedSandboxDispatch({
          ...control,
          ...(dockerControls ? { dockerControls: makeDockerControls(true) } : {}),
        }),
      );
    },
  };
}

export type ServerServices = Awaited<ReturnType<typeof createServerServices>>;
