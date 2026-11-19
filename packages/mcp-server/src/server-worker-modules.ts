import { createDockerHostStore } from "./docker-host-store.ts";
import { captureDockerStopOutputs } from "./docker-outputs.ts";
import { startInvitationWorker } from "./invitations.ts";
import { createJobsRunner } from "./jobs/runner.ts";
import { createMcpSandboxProviderResolver } from "./mcp-sandbox-provider.ts";
import { createNativeWebhookPrompts } from "./native-webhook-prompts.ts";
import { createProviderReaper } from "./provider-reaper.ts";
import { pruneServerRetention } from "./retention-maintenance.ts";
import { startRoutineWorker } from "./routine-worker.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeIdle } from "./runtime-idle.ts";
import { createFinishedDockerCleanup } from "./sandbox-finish.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { createSandboxPullRequests } from "./sandbox-pull-requests.ts";
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

const pullRequestLane: LaneFactory = ({ githubApp, sql, store, config, lifecycleProvider, runtimeCommands }) =>
  githubApp
    ? createSandboxPullRequests(
        sql,
        { store, app: githubApp, encryptionKey: config.encryptionKey },
        async (target, request) => {
          if (!target.runtime) return (await lifecycleProvider(target.id)).exec(request);
          return createRuntimeAgent(runtimeCommands, {
            provider: target.provider,
            harness: target.harness,
            ownerId: target.owner_id,
            sandboxId: target.id,
            providerSandboxId: target.provider_sandbox_id,
            cwd: "/home/user",
            defaults: { model: "", reasoningEffort: "" },
          }).exec(request);
        },
      )
    : undefined;

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

const jobsLane: LaneFactory = ({ jobs, langfuse, options }) =>
  createJobsRunner(jobs, { langfuse_export: langfuse.exportJob }, options.logError);
const dockerCleanupLane: LaneFactory = ({ sql, config }) => createFinishedDockerCleanup(sql, config.encryptionKey);
export const retentionWorker =
  ({ sql, control }: ServerServices) =>
  () =>
    pruneServerRetention(sql, control.applicationVault, new Date());

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
  workers.managed.set("pull-requests", pullRequestLane);
  workers.managed.set("jobs", jobsLane);
};
export const outputModule: ServerModule = ({ mounts, workers }) => {
  mounts.push(outputMounts);
  workers.managed.set("outputs", ({ outputs }) => outputs);
  workers.managed.set("webhooks", ({ webhooks }) => webhooks);
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
export const modalModule: ServerModule = ({ mounts, workers }) => {
  mounts.push(({ modal }) => [modal.route]);
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
