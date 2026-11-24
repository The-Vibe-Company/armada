import { startBoatRuntime } from "@armada/provider-boat";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions, type RuntimeLaunchPolicy } from "./runtime-launch.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

export function boatRuntimeActivation(
  options: RuntimeLaunchOptions & {
    modelAuth?: RuntimeConfigurationInput["modelAuth"];
  },
) {
  const startRuntime = createRuntimeLaunch(options, "boat", (sandbox) => sandbox.boatRuntime === true);
  const manifest = structuredClone(options.manifest);
  const { architecture, modelAuth } = options;
  return {
    supportsScopedAccess: true,
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      return startRuntime({
        input,
        configure: () =>
          runtimeConfigurationWithVariables(
            options.sql,
            {
              actor,
              sandbox,
              credentials,
              manifest,
              architecture,
              ...(modelAuth ? { modelAuth } : {}),
            },
            "boat",
            "boat_runtime_empty_v1",
          ),
        bootstrap: () => (request) => startBoatRuntime(host, request),
      });
    },
  } satisfies RuntimeLaunchPolicy;
}
