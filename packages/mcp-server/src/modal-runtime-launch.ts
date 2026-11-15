import type { LaunchOptions } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import type { RuntimeConfigurationInput } from "./runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";
import { runtimeConfigurationWithVariables } from "./runtime-readable-variables.ts";

/** First-answer slice: same enrolled startup and journal, Modal supplies only compute. */
export function modalRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    modelAuth?: NonNullable<RuntimeConfigurationInput["modelAuth"]>;
  },
): NonNullable<LaunchOptions["runtime"]> {
  const startRuntime = createRuntimeLaunch(options);
  return {
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      if (host.id !== "modal" || sandbox.runtimeTransport !== "dialout") throw Error("runtime_selection_required");
      return startRuntime({
        input,
        configure: () =>
          runtimeConfigurationWithVariables(
            options.sql,
            { ...options, actor, sandbox, credentials },
            "modal",
            "modal_runtime_empty_v1",
          ),
        bootstrap: () => {
          const start = (host as Partial<ModalProvider>).startRuntime;
          if (!start) throw Error("modal_runtime_host_required");
          return (request) => start.call(host, request);
        },
      });
    },
  };
}
