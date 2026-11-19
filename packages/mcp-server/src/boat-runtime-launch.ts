import type { LaunchOptions } from "@armada/core/server";
import { startBoatRuntime } from "@armada/provider-boat";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

/** Build policy once; choose it explicitly for a launch, never as a native fallback.
 * Manifest/origin are trusted server deployment inputs, not client parameters.
 */
export function boatRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    modelAuth?: RuntimeConfigurationInput["modelAuth"];
  },
): NonNullable<LaunchOptions["boatRuntime"]> {
  const startRuntime = createRuntimeLaunch(options, "boat");
  const manifest = structuredClone(options.manifest);
  const { architecture, modelAuth } = options;
  return {
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      if (sandbox.boatRuntime !== true || host.id !== "boat") throw Error("runtime_selection_required");
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
  };
}
