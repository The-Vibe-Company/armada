import type { ModalProvider } from "@armada/provider-modal";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions, type RuntimeLaunchPolicy } from "./runtime-launch.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

/** First-answer slice: same enrolled startup and journal, Modal supplies only compute. */
export function modalRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    modelAuth?: NonNullable<RuntimeConfigurationInput["modelAuth"]>;
  },
): RuntimeLaunchPolicy {
  const startRuntime = createRuntimeLaunch(options, "modal");
  return {
    supportsScopedAccess: true,
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      const resumeGeneration = input.restoreCheckpoint ? sandbox.lifecycleGeneration : undefined;
      return startRuntime({
        input,
        configure: () =>
          runtimeConfigurationWithVariables(
            options.sql,
            { ...options, actor, sandbox, credentials },
            "modal",
            "modal_runtime_empty_v1",
          ),
        async commandGrantDeadline(logicalExpiresAt) {
          const physical = await host.get(sandbox.providerSandboxId, { signal: input.signal });
          input.signal.throwIfAborted();
          const expiresAt = physical.expiresAt?.getTime();
          if (
            physical.providerState !== "active" ||
            !["ready", "running"].includes(physical.state) ||
            physical.physicalExitConfirmed ||
            expiresAt === undefined ||
            !Number.isFinite(expiresAt) ||
            expiresAt < logicalExpiresAt
          )
            throw Error("modal_runtime_physical_deadline_unavailable");
          return expiresAt;
        },
        bootstrap: () => {
          const start = (host as Partial<ModalProvider>).startRuntime;
          if (!start) throw Error("modal_runtime_host_required");
          return (request) =>
            start.call(host, {
              ...request,
              ...(resumeGeneration === undefined ? {} : { resumeGeneration }),
            });
        },
      });
    },
  };
}
