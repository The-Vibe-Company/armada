import type { LaunchOptions } from "@armada/core/server";
import { startBoatRuntime } from "@armada/provider-boat";
import { boatRuntimeConfiguration } from "./boat-runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";

/** Build policy once; choose it explicitly for a launch, never as a native fallback.
 * Manifest/origin are trusted server deployment inputs, not client parameters.
 */
export function boatRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    modelAuth?: Parameters<typeof boatRuntimeConfiguration>[0]["modelAuth"];
  },
): NonNullable<LaunchOptions["boatRuntime"]> {
  const startRuntime = createRuntimeLaunch(options);
  const manifest = structuredClone(options.manifest);
  const { architecture, modelAuth } = options;
  return {
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      if (sandbox.boatRuntime !== true || host.id !== "boat") throw Error("runtime_selection_required");
      return startRuntime({
        input,
        configure: () =>
          boatRuntimeConfiguration(
            {
              actor,
              sandbox,
              credentials,
              manifest,
              architecture,
              ...(modelAuth ? { modelAuth } : {}),
            },
            options.sql,
          ),
        bootstrap: () => (request) => startBoatRuntime(host, request),
      });
    },
  };
}
