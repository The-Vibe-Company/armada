import { githubInstallationAppFromEnv } from "@armada/core/server";
import { authenticateCaller } from "./caller.ts";
import { handleControlRequest } from "./control.ts";
import { createDockerHostInstallRoute } from "./docker-host-install.ts";
import { createDockerHostRoutes } from "./docker-host-routes.ts";
import { createDockerHostStore } from "./docker-host-store.ts";
import { createDockerRuntimeLifecycle } from "./docker-runtime-lifecycle.ts";
import { createDockerSandboxRoutes } from "./docker-sandbox-routes.ts";
import { createDockerSandboxService } from "./docker-sandbox-service.ts";
import { createDockerSnapshots } from "./docker-snapshots.ts";
import { inboundTriggerAdminRoute } from "./inbound-trigger-admin.ts";
import { inboundTriggerRoute } from "./inbound-trigger-route.ts";
import { createInboundTriggerStore } from "./inbound-trigger-store.ts";
import { createRuntimeArtifactRoute } from "./runtime-artifacts.ts";
import { createRuntimeModelAccess } from "./runtime-model-access.ts";
import { createRuntimeProgress } from "./runtime-progress.ts";
import type { MountFactory, ServerModule } from "./server-registration.ts";

const authenticate =
  ({ authStore, handlerOptions }: Parameters<MountFactory>[0]) =>
  (request: Request) =>
    authenticateCaller(request.headers.get("authorization"), {
      store: authStore,
      supabase: handlerOptions.supabase,
      now: new Date(),
    });

const triggerMounts: MountFactory = (services) => {
  const { sql, jobs, config } = services;
  return [
    inboundTriggerRoute(createInboundTriggerStore(sql, jobs, config.encryptionKey)),
    inboundTriggerAdminRoute(sql, authenticate(services), config.encryptionKey),
  ];
};

export const dockerMounts: MountFactory = (services, configureDockerArchiveTimeout) => {
  const { env, sql, config, options, store, githubApp, dockerEnabled, dockerBootstrap, dockerLaunchEnabled } = services;
  return [
    ...(env.ARMADA_DOCKER_HOSTS === "1"
      ? [
          createDockerSandboxRoutes(
            {
              sandboxes: createDockerSandboxService(sql, config.encryptionKey, { enabled: dockerEnabled }),
              ...(dockerBootstrap ? { bootstrap: dockerBootstrap } : {}),
              runtime: createDockerRuntimeLifecycle(sql, config.encryptionKey, { enabled: dockerEnabled }),
            },
            authenticate(services),
          ),
          createDockerHostRoutes(createDockerHostStore(sql, config.encryptionKey), authenticate(services), {
            placement: dockerLaunchEnabled,
            ...(options.log ? { log: options.log } : {}),
            configureArchiveTimeout: (request) => configureDockerArchiveTimeout?.(request),
            publicUrl: config.publicUrl,
            snapshots: createDockerSnapshots(sql, config.encryptionKey, {
              enabled: dockerLaunchEnabled,
              github: { store, app: githubApp, encryptionKey: config.encryptionKey },
              installationApp: githubInstallationAppFromEnv(env),
            }),
          }),
        ]
      : []),
    createDockerHostInstallRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR, config.publicUrl),
  ];
};

export const runtimeMounts: MountFactory = (services) => {
  const {
    env,
    sql,
    config,
    runtimeEnrolments,
    modelAuth,
    runtimeEvents,
    langfuse,
    runtimeCommands,
    runtimeGitHub,
    delegatedAccess,
    dockerArtifactSet,
  } = services;
  return [
    createRuntimeArtifactRoute(env.ARMADA_RUNTIME_ARTIFACT_DIR),
    ...(dockerArtifactSet ? [dockerArtifactSet] : []),
    runtimeEnrolments.route,
    createRuntimeProgress(runtimeEnrolments),
    createRuntimeModelAccess(sql, config.encryptionKey, modelAuth.broker),
    runtimeEvents.route,
    langfuse.route(authenticate(services)),
    runtimeCommands.route,
    ...(runtimeGitHub ? [runtimeGitHub.route] : []),
    delegatedAccess.scopedToolsRoute,
    ...(modelAuth.broker ? [modelAuth.broker.route] : []),
  ];
};

const controlMount: MountFactory = ({ control }) => [(request) => handleControlRequest(request, control)];

export const outputMounts: MountFactory = (services) => [
  services.outputs.route(authenticate(services)),
  services.webhooks.route(authenticate(services)),
];

export const scriptedModelModule: ServerModule = ({ mounts }) =>
  mounts.push(({ scriptedModel }) => (scriptedModel ? [scriptedModel] : []));
export const triggerModule: ServerModule = ({ mounts }) => mounts.push(triggerMounts);
export const controlMountModule: ServerModule = ({ mounts }) =>
  mounts.push(controlMount, ({ options }) => options.routes ?? []);
