import { createTurnDispatchJob } from "./account-turn-dispatch.ts";
import { createQueuedSandboxDispatch } from "./control.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { createGoldenRuntimeEnvironment } from "./golden-runtime-environment.ts";
import { createGoldenBuildJob } from "./golden-worker.ts";
import { startInvitationWorker } from "./invitations.ts";
import { createModalInitialTurnJob, MODAL_INITIAL_TURN } from "./jobs/modal-launch.ts";
import { createJobsRunner } from "./jobs/runner.ts";
import { createStopJob } from "./jobs/stop.ts";
import { createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
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
  const { sql, providers } = services;
  const lifecycleProvider = createMcpSandboxProviderResolver(sql, providers);
  const lifecycle = createSandboxLifecycle(sql, lifecycleProvider);
  return { ...services, lifecycle };
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
  providers,
  runtimeCommands,
  runtimeGitHub,
  runtimeMcp,
  webhooks,
  options,
  outputs,
  langfuse,
  control,
  modal,
  launchJob,
  resumeJob,
  launchCleanupJob,
  accountTurns,
  deploymentId,
}) => {
  const prScan = githubApp
    ? createPullRequestScanJob(
        sql,
        jobs,
        { store, app: githubApp, encryptionKey: config.encryptionKey },
        async (target, request) => {
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
      delete: launchCleanupJob ?? modal.launchCleanupJob,
      ...(launchJob ? { launch: launchJob } : {}),
      ...(config.encryptionKey
        ? {
            resume: resumeJob,
            stop: createStopJob(
              sql,
              config.encryptionKey,
              undefined,
              undefined,
              createMcpSandboxProviderResolver(sql, providers),
              deploymentId,
            ),
            [MODAL_INITIAL_TURN]: createModalInitialTurnJob(
              sql,
              config.encryptionKey,
              accountTurns,
              createGoldenRuntimeEnvironment(sql, config.encryptionKey),
              runtimeCommands,
              runtimeMcp.prepare,
              runtimeGitHub,
              control.sandboxArmadaAccess?.restoreEnrolled,
            ),
            turn_dispatch: createTurnDispatchJob(sql, config.encryptionKey, createQueuedSandboxDispatch(control)),
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
      return runner.reconcileOne(signal);
    },
    async drain() {
      await runner.drain();
      await outputs.drain();
    },
  };
};

const idleLane: LaneFactory = ({ sql, config, runtimeCheckpoint, idleDelayMs, dockerBootstrap, relayHub }) =>
  createRuntimeIdle(sql, config.encryptionKey, runtimeCheckpoint, {
    delayMs: idleDelayMs,
    hasActiveRelay: (sandboxId) => relayHub.hasActiveRelay(sandboxId),
    ...(dockerBootstrap
      ? {
          dockerStop: (actor, id, requestId) =>
            createDockerHostStore(sql, config.encryptionKey).enqueueStop(actor, id, requestId, {
              checkpoint: requestId,
            }),
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
export const delegatedAccessModule: ServerModule = ({ workers }) => {
  workers.managed.set("delegated-access", ({ delegatedAccess }) => delegatedAccess.childWorker);
};
export const dockerModule: ServerModule = ({ mounts, workers }) => {
  mounts.push(dockerMounts);
  workers.managed.set("docker-cleanup", dockerCleanupLane);
};
export const runtimeModule: ServerModule = ({ mounts, workers, shutdown }) => {
  mounts.push(runtimeMounts);
  workers.managed.set("runtime-idle", idleLane);
  shutdown.stopSockets = async ({ runtimeSockets, relayHub }) => {
    await Promise.all([runtimeSockets.stop(), relayHub.stop()]);
  };
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

export const modalModule: ServerModule = ({ workers }) => {
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
