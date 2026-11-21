import { createDockerHostStore } from "./docker-host-store.ts";
import { captureDockerStopOutputs } from "./docker-outputs.ts";
import { createGoldenRuntimeEnvironment } from "./golden-runtime-environment.ts";
import { createGoldenBuildJob } from "./golden-worker.ts";
import { startInvitationWorker } from "./invitations.ts";
import { createModalInitialTurnJob, MODAL_INITIAL_TURN } from "./jobs/modal-launch.ts";
import { createJobsRunner } from "./jobs/runner.ts";
import { createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createNativeWebhookPrompts } from "./native-webhook-prompts.ts";
import { createProviderReaper } from "./provider-reaper.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "./retention-maintenance.ts";
import { startRoutineWorker } from "./routine-worker.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeIdle } from "./runtime-idle.ts";
import { createFinishedDockerCleanup } from "./sandbox-finish.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { OUTPUTS_CAPTURE } from "./sandbox-outputs.ts";
import { createPullRequestScanJob } from "./sandbox-pull-requests.ts";
import { dockerMounts, outputMounts, runtimeMounts } from "./server-mounts.ts";
import type { ServerModule } from "./server-registration.ts";
import { createServerRoutineScheduler } from "./server-routines.ts";
import type { ServerServices } from "./server-services.ts";
import type { ServerLifecycleLane } from "./server-workers.ts";

export function createWorkerServices(services: ServerServices) {
  const { sql, providers, idleDelayMs } = services;
  const lifecycleProvider = createMcpSandboxProviderResolver(sql, providers);
  const lifecycle = createSandboxLifecycle(sql, lifecycleProvider, {
    delayMs: idleDelayMs,
  });
  const nativePrompts = createNativeWebhookPrompts(
    sql,
    createMcpSandboxProviderResolver(sql, providers, { terminalObservation: true }),
  );
  return { ...services, lifecycle, lifecycleProvider, nativePrompts };
}

type WorkerServices = ReturnType<typeof createWorkerServices>;
export type LaneFactory = (services: WorkerServices) => ServerLifecycleLane | undefined;

const jobsLane: LaneFactory = ({
  githubApp,
  goldenBuilds,
  goldenRetirements,
  sql,
  jobs,
  store,
  config,
  lifecycleProvider,
  runtimeCommands,
  runtimeGitHub,
  webhooks,
  options,
  outputs,
  langfuse,
  control,
  modal,
  modalLaunchJob,
  accountTurns,
}) => {
  const prScan = githubApp
    ? createPullRequestScanJob(
        sql,
        jobs,
        { store, app: githubApp, encryptionKey: config.encryptionKey },
        async (target, request, canDispatch) => {
          if (!target.runtime) {
            const provider = await lifecycleProvider(target.id);
            if (provider.supportsExecPhysicalGeneration) {
              const { physicalGeneration } = await provider.get(
                request.sandboxId,
                request.signal ? { signal: request.signal } : undefined,
              );
              if (!physicalGeneration) throw Error("No physical incarnation for native PR scan.");
              request = { ...request, expectedPhysicalGeneration: physicalGeneration };
            }
            if (!(await canDispatch())) throw Error("PR scan generation changed.");
            request.signal?.throwIfAborted();
            return provider.exec(request);
          }
          const epoch = target.runtime_epoch;
          if (epoch === null) throw Error("No enrolled runtime for PR scan.");
          return createRuntimeAgent(
            {
              call: (owner, command, options) =>
                runtimeCommands.call(owner, command, { ...options, expectedEpoch: epoch }),
            },
            {
              provider: target.provider,
              harness: target.harness,
              ownerId: target.owner_id,
              sandboxId: target.id,
              providerSandboxId: target.provider_sandbox_id,
              cwd: "/home/user",
              defaults: { model: "", reasoningEffort: "" },
            },
          ).exec(request);
        },
      )
    : undefined;
  const runner = createJobsRunner(
    jobs,
    {
      delete: modal.launchCleanupJob,
      ...(modalLaunchJob ? { launch: modalLaunchJob } : {}),
      ...(config.encryptionKey
        ? {
            [MODAL_INITIAL_TURN]: createModalInitialTurnJob(
              sql,
              accountTurns,
              createGoldenRuntimeEnvironment(sql, config.encryptionKey),
              runtimeCommands,
              runtimeGitHub,
            ),
          }
        : {}),
      golden_build: createGoldenBuildJob(goldenBuilds),
      langfuse_export: langfuse.exportJob,
      maintenance: retentionMaintenanceJob(sql, control.applicationVault, options.logError),
      webhook: { concurrency: 1, run: webhooks.run },
      ...(prScan ? { pr_scan: prScan } : {}),
      ...(config.encryptionKey ? { [OUTPUTS_CAPTURE]: outputs.captureJob } : {}),
      snapshot_retirement: {
        concurrency: 4,
        timeoutMs: 30_000,
        run: (job, context) => goldenRetirements.runJob(job.id, context),
      },
    },
    options.logError,
  );
  let seeded = false;
  return {
    ...runner,
    async reconcileOne(signal) {
      if (!seeded && !signal.aborted) {
        try {
          await seedRetentionMaintenance(jobs);
          seeded = true;
        } catch {
          (options.logError ?? console.error)("armada: retention maintenance scheduling unavailable.");
        }
      }
      try {
        await outputs.enqueueCaptures(jobs, signal);
      } catch {
        (options.logError ?? console.error)("armada: output capture scheduling unavailable.");
      }
      if (config.encryptionKey && !signal.aborted) {
        try {
          await accountTurns.backfillDispatchJobs(signal);
        } catch {
          (options.logError ?? console.error)("armada: queued turn job backfill unavailable.");
        }
      }
      return runner.reconcileOne(signal);
    },
    async drain() {
      await runner.drain();
      await outputs.drain();
    },
  };
};

const idleLane: LaneFactory = ({ sql, config, runtimeCheckpoint, idleDelayMs, dockerBootstrap }) =>
  createRuntimeIdle(sql, config.encryptionKey, runtimeCheckpoint, {
    delayMs: idleDelayMs,
    ...(dockerBootstrap
      ? {
          dockerStop: async (actor, id, requestId) => {
            await captureDockerStopOutputs(sql, config.encryptionKey, id);
            return createDockerHostStore(sql, config.encryptionKey).enqueueSandbox(actor, id, {
              operation: "stop",
              requestId,
              idleCheckpointRequest: requestId,
            });
          },
        }
      : {}),
  });

const dockerCleanupLane: LaneFactory = ({ sql, config }) => createFinishedDockerCleanup(sql, config.encryptionKey);
const invitationWorker = ({ env, control }: ServerServices) => {
  const invitations = control.invitations;
  return env.ARMADA_INVITATION_MAIL === "supabase" && invitations
    ? () => startInvitationWorker(invitations)
    : undefined;
};

const routineWorker =
  ({ sql, control, templates, providers, data, options }: ServerServices) =>
  () =>
    startRoutineWorker(createServerRoutineScheduler({ sql, control, templates, providers, data }), options.logError);

export function extraReaperLanes({ options }: ServerServices) {
  return (options.providerReaperSources ?? []).map((source) => ({
    name: `${source.provider}-inventory:${source.sourceId}`,
    lane: createProviderReaper(source, options.log),
  }));
}

export const jobsModule: ServerModule = ({ workers }) => {
  workers.managed.set("jobs", jobsLane);
};
export const outputModule: ServerModule = ({ mounts }) => {
  mounts.push(outputMounts);
};
export const nativeModule: ServerModule = ({ workers }) => {
  workers.managed.set("native-prompts", ({ nativePrompts }) => nativePrompts);
  workers.managed.set("delegated-access", ({ delegatedAccess }) => delegatedAccess.childWorker);
};
export const dockerModule: ServerModule = ({ mounts, workers, shutdown }) => {
  mounts.push(dockerMounts);
  workers.beforeListen.push(({ dockerLaunch }) => dockerLaunch?.startBackground());
  workers.managed.set("docker-cleanup", dockerCleanupLane);
  shutdown.closeDocker = ({ dockerLaunch }) => dockerLaunch?.close();
};
export const runtimeModule: ServerModule = ({ mounts, workers, shutdown }) => {
  mounts.push(runtimeMounts);
  workers.managed.set("account-turns", ({ accountTurns }) => accountTurns);
  workers.managed.set("runtime-idle", idleLane);
  workers.isolated.set("steer-recovery", ({ nativePrompts }) => nativePrompts.steerRecovery);
  shutdown.stopSockets = ({ runtimeSockets }) => runtimeSockets.stop();
};
const modalArtifactWorker = ({ modal, modalArtifactCache, options }: ServerServices) => {
  if (!modalArtifactCache) return undefined;
  return () => {
    const stop = new AbortController();
    const logError = options.logError ?? console.error;
    const done = modal
      .warmRegisteredArtifactCaches(modalArtifactCache, stop.signal, logError)
      .catch(() => logError("Modal startup artifact warming failed while accessing the registry database."));
    return { stop: () => stop.abort(), done };
  };
};

export const modalModule: ServerModule = ({ mounts, workers }) => {
  mounts.push(({ modal }) => [modal.route]);
  workers.background.set("modal-artifacts", modalArtifactWorker);
  workers.isolated.set("modal-inventory", ({ modal, options }) => modal.inventoryReaper(options.log));
};
export const mcpBackgroundModule: ServerModule = ({ workers }) =>
  workers.beforeListen.push(({ mcp }) => mcp.startBackground());
export const mcpModule: ServerModule = ({ mounts, shutdown }) => {
  mounts.push(({ mcp }) => [mcp.route]);
  shutdown.closeMcp = ({ mcp }) => mcp.close();
};
export const invitationModule: ServerModule = ({ workers }) => workers.background.set("invitations", invitationWorker);
export const routineModule: ServerModule = ({ workers }) => workers.background.set("routines", routineWorker);
