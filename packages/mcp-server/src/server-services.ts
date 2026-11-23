import { createSqlAuthStore } from "@armada/auth";
import {
  createApplicationVault,
  createGoldenAdoption,
  createRoutineService,
  createSkillDefaultsService,
  createSqlVaultStore,
  createTemplateService,
  GoldenBuildJobs,
  type GoldenRecord,
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
import { createSqlCredentialList } from "./credential-list-sql.ts";
import { createScopedSandboxData, createSqlData, type SandboxView } from "./data.ts";
import { retryDatabaseBoot } from "./database-boot.ts";
import { createDatabaseReadiness } from "./database-readiness.ts";
import { requireDatabaseSchema } from "./database-schema.ts";
import { deviceLoginFromConfig } from "./device-login-control.ts";
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
import { admitModalLaunch, modalLaunchTicketGuard } from "./jobs/modal-launch.ts";
import { createJobsStore } from "./jobs/store.ts";
import { createLangfuse } from "./langfuse.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { bootstrapBoatMcp } from "./mcp-native.ts";
import { createHistoricalSandboxProviderResolver, createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalArtifactCache } from "./modal-artifact-cache.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModalLaunchAdmission } from "./modal-launch-admission.ts";
import { modalRuntimeLaunch } from "./modal-runtime-launch.ts";
import { modalRuntimeResume } from "./modal-runtime-resume.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import type { NamedLaunchCredentials } from "./named-credentials.ts";
import { withNativeLogJournal } from "./native-log-journal.ts";
import { createObservedBoatProvider } from "./observed-boat.ts";
import { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import { createOutboundWebhooks } from "./outbound-webhooks.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import type { ProviderReaperSource } from "./provider-reaper.ts";
import { diagnosticSandboxId } from "./provider-sandbox-target.ts";
import { createRuntimeArtifactSetRoute } from "./runtime-artifacts.ts";
import { createRuntimeCheckpoint, createRuntimeStopCheckpoint } from "./runtime-checkpoint.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeEvents } from "./runtime-events.ts";
import { createRuntimeFollowup } from "./runtime-followup.ts";
import { createRuntimeGitHub } from "./runtime-github.ts";
import { createModalJobReader, createModalLogReader } from "./runtime-history.ts";
import { createRuntimeMcp } from "./runtime-mcp.ts";
import { createRuntimeNativeAuth } from "./runtime-native-auth.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";
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
  const supabase = {
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    cliOAuthClientId: env.ARMADA_CLI_OAUTH_CLIENT_ID,
  };
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
    supabase,
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
          return modelAuth.redactBoatEvents(provider, id, caller, events);
        },
        beforeStop: async (provider, id) => {
          if (caller) await modelAuth.beforeStop(provider, id, caller);
        },
        afterPrompt: async (provider, id) => {
          if (caller) await modelAuth.captureAfterBoatPrompt(provider, id, caller);
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
  const modal = createModalIntegration({
    sql,
    vault: store,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
  });
  const modalProviderFor: NonNullable<HandlerOptions["modalProviderFor"]> = async (...args) => {
    const target = args[2].target;
    if (diagnosticSandboxId(target) && target.runtimeTransport !== "dialout")
      throw new VaultError("unavailable", "Modal sandboxes require Armada runtime enrolment.");
    const ports = await modal.modalProviderFor(...args);
    return { ...ports, provider: sandboxArmadaAccess.wrap(ports.provider) };
  };
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
      provider: async (actor, golden: GoldenRecord & { sourceGoldenVisibility?: GoldenRecord["visibility"] }) =>
        runtimeHostFor(
          (
            await resolveBoatKey(store, config.encryptionKey, {
              userId: actor.userId,
              orgId: actor.orgId,
              visibility: golden.sourceGoldenVisibility ?? golden.visibility,
            })
          ).key,
        ),
    };
    if (config.boatAgentPath === "runtime") launch.boatRuntimeDefault = launch.boatEndpointRuntime;
  }
  const { manifest, artifactDir } = modalRuntime;
  const warmModalArtifacts = createModalArtifactCache(manifest, artifactDir);
  const modalRuntimePolicy = modalRuntimeLaunch({
    sql,
    encryptionKey: config.encryptionKey,
    serverUrl: config.publicUrl,
    manifest,
    architecture: manifest.architecture,
    ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
    modelAuth,
  });
  const modalLaunchCredentials = launchCredentials(store, config.encryptionKey, undefined, modelAuth, {
    store,
    app: githubApp,
  });
  const modalLaunchJob = modal.launchJob(async (sandbox, computeExpiresAt) => {
    if (!sandbox.credentialId || !sandbox.credentialVersion) throw new Error("Modal launch account pin is missing.");
    const actor = { userId: sandbox.ownerId, orgId: sandbox.orgId, role: "member" as const };
    const credentials = await modalLaunchCredentials.resolve(
      actor,
      sandbox.harness,
      sandbox.credentialId,
      sandbox.credentialVersion,
    );
    await modalLaunchCredentials.enrollAccount?.(actor, credentials);
    const plan = await runtimeConfigurationWithVariables(
      sql,
      {
        actor,
        sandbox,
        credentials,
        manifest: modalRuntime.manifest,
        architecture: modalRuntime.manifest.architecture,
        modelAuth,
      },
      "modal",
      "modal_runtime_empty_v1",
    );
    if (!Number.isFinite(computeExpiresAt) || computeExpiresAt < plan.configuration.grant.expiresAt)
      throw new Error("Modal compute deadline does not cover the initial runtime grant.");
    plan.configuration.grant.expiresAt = computeExpiresAt;
    return {
      ...plan,
      ownerId: sandbox.ownerId,
      serverUrl: config.publicUrl,
      ...modalLaunchTicketGuard(sandbox),
    };
  });
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
  const modalRuntimeHostFor = async (
    target: import("@armada/core").ProviderTarget,
    caller: import("./caller.ts").Caller,
  ) => {
    if (!target.modal) throw Error("Modal binding required.");
    const tokens = await modal.modalTokensFor(target, caller);
    return (
      await modal.modalProviderFor(
        { tokenId: tokens.tokenId, tokenSecret: tokens.tokenSecret },
        target.modal,
        { target, caller, credentialScope: tokens.scope },
        false,
        (binding) => warmModalArtifacts.beginWarming(binding, options.logError ?? console.error),
      )
    ).provider;
  };
  launch.modalRuntimeDefault = {
    policy: modalRuntimePolicy,
    credentials: modalLaunchCredentials,
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
  const admitModal = createModalLaunchAdmission(
    sql,
    {
      ...launch.modalRuntimeDefault,
      provider: (actor, golden) => modal.launchProviderFor(golden, actor),
    },
    launch,
    (input) => admitModalLaunch(sql, config.encryptionKey, input, runtimeMcp),
  );
  const boatResume = runtimeLaunch
    ? boatRuntimeResume({ sql, vault: store, key: config.encryptionKey, policy: runtimeLaunch, modelAuth })
    : undefined;
  const modalResume = modalRuntimeResume({
    sql,
    vault: store,
    key: config.encryptionKey,
    policy: modalRuntimePolicy,
    modelAuth,
    hostFor: modalRuntimeHostFor,
  });
  const runtimeResume = createRuntimeResume(
    sql,
    config.encryptionKey,
    runtimeCommands,
    (caller, sandbox) => {
      const prepare = { boat: boatResume, modal: modalResume }[sandbox.provider];
      if (!prepare) throw new VaultError("unavailable", "Runtime resume policy unavailable.");
      return prepare(caller, sandbox);
    },
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
  const modalJobReader = createModalJobReader(sql, config.encryptionKey);
  const logProviders = { boat: providers.resolve.bind(providers), modal: modal.storedProviderFor };
  const journalLogProviders = {
    modal: createModalLogReader(sql, config.encryptionKey, logProviders.modal),
    boat: async (sandbox: Parameters<typeof logProviders.boat>[0], caller: Parameters<typeof logProviders.boat>[1]) => {
      const provider = await logProviders.boat(sandbox, caller);
      return sandbox.id && !sandbox.boatRuntime && !sandbox.runtimeTransport && config.encryptionKey
        ? withNativeLogJournal(
            sql,
            config.encryptionKey,
            provider,
            { id: sandbox.id, orgId: sandbox.orgId, userId: caller.userId },
            options.logError,
          )
        : provider;
    },
  };
  const logProvider = (sandbox: SandboxView, caller: import("./caller.ts").Caller) =>
    journalLogProviders[sandbox.provider](sandbox, caller);
  const ordinaryLaunchReceipts = createOrdinaryLaunchReceipts(sql);
  const deviceLogin = deviceLoginFromConfig(sql, config.dashboardUrl, env);
  const control: ConfiguredControlOptions = {
    ...(deviceLogin ? { deviceLogin } : {}),
    ordinaryLaunchReceipts,
    admitModalLaunch: admitModal,
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
    modalRuntimeLaunch: modalRuntimePolicy,
    modalRuntimeHostFor,
    ...(runtimeLaunch ? { boatRuntimeLaunch: runtimeLaunch, runtimeHostFor } : {}),
    launch,
    publicUrl: config.publicUrl,
    modelAuth,
    sandboxBillingAccount: createSandboxBillingAccount(sql),
    credentialBindingRecovery: createSandboxAccountChange(sql, dockerCredentials),
    modelUsage: createModelUsageApi(sql),
    goldenRetirements,
    invitations: new Invitations(sql, config.encryptionKey, invitationMail),
    templates,
    skillDefaults: createSkillDefaultsService(sql),
    routines: createRoutineService(sql),
    applicationVault: createApplicationVault(sql, config.encryptionKey),
    mcp: { registry: mcp.registry, broker: mcp.controlBroker },
    authStore,
    supabase,
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
    modalJobReader,
    storedProviderFor: modal.storedProviderFor,
    logs: async (caller, sandboxId) => {
      const scoped = data(caller);
      const sandbox = await scoped.sandboxes.get(sandboxId);
      if (!sandbox) throw new Error("No such sandbox.");
      return {
        provider: await logProvider(sandbox, caller),
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
    runtimePlacements: { boat: launch.boatRuntimeDefault, modal: launch.modalRuntimeDefault },
    boatEndpointRuntime: launch.boatEndpointRuntime,
    encryptionKey: config.encryptionKey,
    connections: mcp.connections,
    publicUrl: config.publicUrl,
    scopedMcpUrl: orchestratorScopedMcpUrl(config.publicUrl),
    configureMutationRequest: (request: Request) => control.configureScopedMutationRequest?.(request),
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
    logProvider,
    modalJobReader,
    readOutputSnapshot: outputs.readSnapshot,
    ...(dockerControls ? { dockerControls } : {}),
    runtimeSend,
    runtimeStopCheckpoint,
    configureStopRequest: (request) => control.configureStopRequest?.(request),
    get stopAdmissionShutdown() {
      return control.stopAdmissionShutdown;
    },
    accountTurns,
    ...(control.sandboxBillingAccount ? { sandboxBillingAccount: control.sandboxBillingAccount } : {}),
    ready: createDatabaseReadiness(sql),
    launchStageSql: sql,
    idlePauseDelayMs: idleDelayMs,
    ...(commitSha ? { commitSha } : {}),
    runtimeProviderFor,
    ordinaryLaunchReceipts,
    admitModalLaunch: admitModal,
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
    supabase,
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
    runtimeMcp,
    runtimeSockets,
    langfuse,
    delegatedAccess,
    modelAuth,
    modal,
    modalLaunchJob,
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
