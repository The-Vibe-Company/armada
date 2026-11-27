import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlAuthStore } from "@armada/auth";
import { MODEL_CREDENTIAL_KINDS } from "@armada/core";
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
import { startBoatRuntime } from "@armada/provider-boat";
import { repairHistoricalTurnModels } from "./account-model-upgrade.ts";
import { createAccountTurnQueue } from "./account-turn-queue.ts";
import { createAntigravityLogin } from "./antigravity-login.ts";
import { startAntigravityLoginProcess } from "./antigravity-login-process.ts";
import { createBoatRuntimePolicy } from "./boat-runtime-launch.ts";
import { authenticateCaller } from "./caller.ts";
import { boatDeploymentId } from "./config.ts";
import type { ConfiguredControlOptions } from "./control.ts";
import { createSqlCredentialList } from "./credential-list-sql.ts";
import { createScopedSandboxData, createSqlData, type SandboxView } from "./data.ts";
import { retryDatabaseBoot } from "./database-boot.ts";
import { createDatabaseReadiness } from "./database-readiness.ts";
import { requireDatabaseSchema } from "./database-schema.ts";
import { deviceLoginFromConfig } from "./device-login-control.ts";
import { createDockerBootstrapService } from "./docker-bootstrap-service.ts";
import { createDockerLaunchPlacement } from "./docker-launch-placement.ts";
import { createDockerOutputReader } from "./docker-outputs.ts";
import { createDockerSandboxControls } from "./docker-sandbox-controls.ts";
import { createEventFeed } from "./event-feed.ts";
import { createGitHubAccountApi } from "./github-account.ts";
import { createSqlGoldenList } from "./golden-list.ts";
import { type HandlerOptions, providerRegistry, type Route } from "./http.ts";
import { Invitations } from "./invitations.ts";
import { boatLaunchBinding, boatLaunchJobs } from "./jobs/boat-launch.ts";
import { createLaunchJob } from "./jobs/launch.ts";
import { admitModalLaunch, modalLaunchTicketGuard } from "./jobs/modal-launch.ts";
import { createResumeJob } from "./jobs/resume.ts";
import type { JobKind } from "./jobs/runner.ts";
import { createJobsStore } from "./jobs/store.ts";
import { createLangfuse } from "./langfuse.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { createMcpHttpIntegration } from "./mcp-http-integration.ts";
import { createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createModalArtifactCache } from "./modal-artifact-cache.ts";
import { createModalIntegration } from "./modal-integration.ts";
import { createModalLaunchAdmission } from "./modal-launch-admission.ts";
import { createModalRuntimePolicy } from "./modal-runtime-policy.ts";
import { createModelAuthOwnership } from "./model-auth.ts";
import { createModelUsageApi } from "./model-usage.ts";
import { createObservedBoatProvider, withBoatManagementIdentity } from "./observed-boat.ts";
import { createOutboundWebhooks } from "./outbound-webhooks.ts";
import { createProviderMetadata } from "./provider-metadata.ts";
import type { ProviderReaperSource } from "./provider-reaper.ts";
import { diagnosticSandboxId } from "./provider-sandbox-target.ts";
import { createRelayHub } from "./relay-hub.ts";
import { createRelayPreview } from "./relay-preview.ts";
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
import { createSandboxListTurns } from "./sandbox-list-turns.ts";
import { createSandboxOutputs } from "./sandbox-outputs.ts";
import sourceIdentity from "./source-identity.json";
import { readStartupConfiguration } from "./startup-configuration.ts";

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
  const deploymentId = boatDeploymentId(env.ARMADA_BOAT_DEPLOYMENT_ID, config.publicUrl);
  const boatInventory = { deploymentId };
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
  const modelAuth = createModelAuthOwnership(sql, config.encryptionKey, undefined, {
    origin: config.publicUrl,
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
    deferBackground: true,
    catalogAuthentication,
    sql,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    dashboardUrl: config.dashboardUrl,
    development: config.development,
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
  const providerFor = (apiKey: string, _caller?: { userId: string; orgId: string }, sandboxId?: string) => {
    const provider = createObservedBoatProvider(
      {
        apiKey,
        ...boatInventory,
      },
      sandboxId,
    );
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
    if (diagnosticSandboxId(target) && target.modalTransport !== "dialout")
      throw new VaultError("unavailable", "Modal sandboxes require Armada runtime enrolment.");
    const ports = await modal.modalProviderFor(...args);
    return { ...ports, provider: sandboxArmadaAccess.wrap(ports.provider) };
  };
  const runtimeProviderFor = createRuntimeServing(sql, config.encryptionKey);
  const providers = providerRegistry({
    runtimeProviderFor,
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
  const runtimeLaunch = boat
    ? createBoatRuntimePolicy({
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
    launch.boatRuntimeDefault = {
      policy: runtimeLaunch,
      credentials: launchCredentials(store, config.encryptionKey, undefined, modelAuth, { store, app: githubApp }),
      connections: runtimeMcp.connections,
      provider: async (actor, golden: GoldenRecord & { sourceGoldenVisibility?: GoldenRecord["visibility"] }) => {
        const { key, scope } = await resolveBoatKey(store, config.encryptionKey, {
          userId: actor.userId,
          orgId: actor.orgId,
          visibility: golden.sourceGoldenVisibility ?? golden.visibility,
        });
        return withBoatManagementIdentity(runtimeHostFor(key), scope, scope === "org" ? actor.orgId : actor.userId);
      },
    };
  }
  const { manifest, artifactDir } = modalRuntime;
  const warmModalArtifacts = createModalArtifactCache(manifest, artifactDir);
  const modalRuntimePolicy = createModalRuntimePolicy({
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
  const runtimeArtifacts = { boat, modal: modalRuntime };
  const prepareLaunchTicket: Parameters<ReturnType<typeof createModalIntegration>["launchJob"]>[0] = async (
    sandbox,
  ) => {
    const provider = sandbox.provider as keyof typeof runtimeArtifacts;
    const artifacts = runtimeArtifacts[provider];
    if (!artifacts) throw new Error("Runtime artifacts are unavailable.");
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
        manifest: artifacts.manifest,
        architecture: artifacts.manifest.architecture,
        modelAuth,
      },
      provider,
      `${provider}_runtime_empty_v1`,
    );
    return {
      ...plan,
      ownerId: sandbox.ownerId,
      serverUrl: config.publicUrl,
      ...modalLaunchTicketGuard(sandbox),
    };
  };
  const modalJob = modal.launchJob(prepareLaunchTicket, warmModalArtifacts, options.logError);
  const boatJobs = boat
    ? boatLaunchJobs({
        sql,
        encryptionKey: config.encryptionKey,
        deploymentId,
        prepareTicket: prepareLaunchTicket,
      })
    : undefined;
  const combineGoldenJobs = (modalJob: JobKind, boatRun?: JobKind["run"]) => ({
    ...modalJob,
    run(job: Parameters<typeof modalJob.run>[0], context: Parameters<typeof modalJob.run>[1]) {
      if (typeof job.payload !== "object" || job.payload === null || !("boat" in job.payload))
        return modalJob.run(job, context);
      if (!boatRun) throw new Error("Boat launch worker is unavailable.");
      return boatRun(job, context);
    },
  });
  const launchCleanupJob = combineGoldenJobs(modal.launchCleanupJob, boatJobs?.cleanup);
  const dockerCredentials = launchCredentials(store, config.encryptionKey, undefined, modelAuth, {
    store,
    app: githubApp,
  });
  let dockerBootstrap: ReturnType<typeof createDockerBootstrapService> | undefined;
  let dockerArtifactSet: ReturnType<typeof createRuntimeArtifactSetRoute> | undefined;
  if (dockerManifest) {
    dockerArtifactSet = createRuntimeArtifactSetRoute(dockerManifest);
    dockerBootstrap = createDockerBootstrapService(sql, config.encryptionKey, {
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
        { ...golden, modalTransport: "dialout" },
        {
          userId: actor.userId,
          orgs: [{ orgId: actor.orgId, role: actor.role }],
          via: "service",
        },
      ),
  };
  const admitModalGolden = createModalLaunchAdmission(
    sql,
    {
      ...launch.modalRuntimeDefault,
      provider: (actor, golden) => modal.launchProviderFor(golden, actor),
    },
    launch,
    (input) => admitModalLaunch(sql, config.encryptionKey, input, runtimeMcp),
  );
  const admitBoat =
    boatJobs &&
    launch.boatRuntimeDefault &&
    createModalLaunchAdmission(sql, launch.boatRuntimeDefault, launch, (input) =>
      admitModalLaunch(sql, config.encryptionKey, input, runtimeMcp),
    );
  const goldenAdmissions = { boat: admitBoat, modal: admitModalGolden };
  const admitModal: typeof admitModalGolden = (actor, golden, ...rest) => {
    const admit = goldenAdmissions[golden.provider];
    if (!admit) throw new VaultError("unavailable", "Boat launch admission is unavailable.");
    return admit(actor, golden, ...rest);
  };
  const accountTurns = createAccountTurnQueue(sql, config.encryptionKey);
  const resume = createResumeJob({
    turns: accountTurns,
    sql,
    key: config.encryptionKey,
    commands: runtimeCommands,
    provider: (caller, sandbox) => modalRuntimeHostFor(sandbox, caller),
    boat: async (caller, sandbox) => {
      if (!boat) throw new VaultError("unavailable", "Boat runtime artifacts are unavailable.");
      const credential = () =>
        resolveBoatKey(store, config.encryptionKey, {
          userId: caller.userId,
          orgId: sandbox.orgId,
          visibility: sandbox.sourceGoldenVisibility ?? sandbox.visibility ?? "private",
        });
      const authority = await credential();
      const host = createObservedBoatProvider({ apiKey: authority.key }, sandbox.id);
      const {
        rows: [launch],
      } = await sql.query<{ scope: string | null; backend: string | null }>(
        `select launch.authority->>'scope' as scope,launch.authority->>'backendId' as backend
         from public.sandboxes s join lateral (${boatLaunchBinding}) launch on true
         where s.id=$1 and s.lifecycle_generation=$2 and s.provider_sandbox_id=$3`,
        [sandbox.id, sandbox.lifecycleGeneration, sandbox.providerSandboxId],
      );
      const backend = await host.backendIdentity?.();
      if (!backend || (launch && (launch.backend !== backend.id || launch.scope !== authority.scope)))
        throw new VaultError("forbidden", "Boat resume authority changed.");
      return {
        host,
        bootstrap: startBoatRuntime,
        providerAuthority: JSON.stringify([authority.scope, backend.id]),
        ...(!launch
          ? { legacyLabels: { armada: "sandbox", sandbox: sandbox.id, org: sandbox.orgId, owner: sandbox.ownerId } }
          : {}),
        async authorize() {
          const current = await credential();
          if (current.key !== authority.key || current.scope !== authority.scope)
            throw new VaultError("forbidden", "Boat resume authority changed.");
        },
      };
    },
    ...(dockerBootstrap ? { docker: dockerBootstrap } : {}),
    prepare: prepareLaunchTicket,
    prepareMcp: runtimeMcp.prepare,
    ...(runtimeGitHub ? { prepareGitHub: runtimeGitHub.prepareLaunch } : {}),
    restoreScopedAccess: sandboxArmadaAccess.restoreEnrolled,
  });
  const runtimeResume = createRuntimeResume(sql, resume.resume);
  const runtimeSend = createRuntimeFollowup(
    sql,
    config.encryptionKey,
    runtimeCommands,
    runtimeMcp.prepare,
    sandboxArmadaAccess.restoreEnrolled,
    resume.wake,
  );
  const dockerControls =
    env.ARMADA_DOCKER_HOSTS === "1"
      ? createDockerSandboxControls(sql, config.encryptionKey, {
          prepareMcp: runtimeMcp.prepare,
          ...(runtimeGitHub ? { prepareSnapshotGitHub: runtimeGitHub.prepareLaunch, github: runtimeGitHub } : {}),
          ...(dockerBootstrap ? { resume: resume.resumeDocker, wakeResume: resume.wake } : {}),
          sendEnabled: dockerEnabled,
        })
      : undefined;
  const dockerLaunchEnabled = dockerEnabled;
  const dockerPlacement =
    env.ARMADA_DOCKER_HOSTS === "1"
      ? createDockerLaunchPlacement(sql, config.encryptionKey, {
          mcp: runtimeMcp,
          ...(runtimeGitHub ? { github: runtimeGitHub } : {}),
          credentials: dockerCredentials,
          ...(dockerBootstrap ? { bootstrap: dockerBootstrap } : {}),
        })
      : undefined;
  const modalJobReader = createModalJobReader(sql, config.encryptionKey);
  const logProviders = { boat: providers.resolve.bind(providers), modal: modal.storedProviderFor };
  const sandboxLogProviders = {
    ...logProviders,
    modal: createModalLogReader(sql, config.encryptionKey, logProviders.modal),
  };
  const logProvider = (sandbox: SandboxView, caller: import("./caller.ts").Caller) =>
    sandboxLogProviders[sandbox.provider](sandbox, caller);
  const deviceLogin = deviceLoginFromConfig(sql, config.dashboardUrl, env);
  const control: ConfiguredControlOptions = {
    ...(MODEL_CREDENTIAL_KINDS.some((kind: string) => kind === "antigravity")
      ? {
          antigravityLogin: createAntigravityLogin((signal) =>
            startAntigravityLoginProcess(join(tmpdir(), "armada-antigravity-login-cache"), signal),
          ),
        }
      : {}),
    ...(deviceLogin ? { deviceLogin } : {}),
    admitModalLaunch: admitModal,
    ...(dockerControls ? { dockerControls } : {}),
    ...(dockerPlacement ? { admitHostLaunch: dockerPlacement.admit } : {}),
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
    ...(boatJobs ? { boatLaunchEnabled: true } : {}),
    launch,
    publicUrl: config.publicUrl,
    modelAuth,
    sandboxListTurns: createSandboxListTurns(sql, config.encryptionKey),
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
      ...(env.GITHUB_APP_ID ? { appId: env.GITHUB_APP_ID } : {}),
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
        sandbox,
      };
    },
  };
  const sandboxAccessContext = {
    sql,
    providers,
    admitLaunch: admitModal,
    runtimeSend,
    runtimeCheckpoint,
    encryptionKey: config.encryptionKey,
    connections: mcp.connections,
    publicUrl: config.publicUrl,
    scopedMcpUrl: orchestratorScopedMcpUrl(config.publicUrl),
    configureMutationRequest: (request: Request) => control.configureScopedMutationRequest?.(request),
  };
  const delegatedAccess = createSandboxAccessServices(sandboxAccessContext);
  control.eventFeed = createEventFeed(sql, delegatedAccess.authority, config.encryptionKey);
  const langfuse = createLangfuse(sql, config.encryptionKey, fetch, {
    logError: options.logError ?? console.error,
  });
  const runtimeEvents = createRuntimeEvents(
    runtimeEnrolments,
    config.encryptionKey,
    createRuntimeNativeAuth(sql, config.encryptionKey),
  );
  const runtimeSockets = createRuntimeSockets(runtimeEnrolments, runtimeCommands);
  const relayHub = createRelayHub({
    sql,
    authority: runtimeEnrolments,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    dashboardUrl: config.dashboardUrl,
  });
  const relayPreview = createRelayPreview({
    relayHub,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    authenticate: (request) =>
      authenticateCaller(request.headers.get("authorization"), { store: authStore, supabase, now: new Date() }),
  });
  control.relayHub = relayHub;
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
    idlePauseDelayMs: idleDelayMs,
    ...(commitSha ? { commitSha } : {}),
    runtimeProviderFor,
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
    deploymentId,
    dockerEnabled,
    dockerBootstrap,
    dockerLaunchEnabled,
    dockerArtifactSet,
    runtimeEnrolments,
    runtimeCommands,
    runtimeEvents,
    runtimeGitHub,
    runtimeMcp,
    runtimeSockets,
    relayHub,
    relayPreview,
    langfuse,
    delegatedAccess,
    modelAuth,
    modal,
    launchJob: createLaunchJob({
      modal: modalJob,
      ...(boatJobs ? { boat: boatJobs.launch } : {}),
      ...(dockerPlacement ? { docker: dockerPlacement.run } : {}),
    }),
    resumeJob: resume.handler,
    launchCleanupJob,
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
  };
}

export type ServerServices = Awaited<ReturnType<typeof createServerServices>>;
