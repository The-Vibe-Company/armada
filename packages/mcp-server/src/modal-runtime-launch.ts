import type { LaunchOptions } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { modalRuntimeConfiguration } from "./modal-runtime-variables.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";

/** First-answer slice: same enrolled startup and journal, Modal supplies only compute. */
export function modalRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    modelAuth?: NonNullable<Parameters<typeof modalRuntimeConfiguration>[1]["modelAuth"]>;
  },
): NonNullable<LaunchOptions["runtime"]> {
  const startRuntime = createRuntimeLaunch(options);
  return {
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      if (host.id !== "modal" || sandbox.runtimeTransport !== "dialout") throw Error("runtime_selection_required");
      return startRuntime({
        input,
        configure: () => modalRuntimeConfiguration(options.sql, { ...options, actor, sandbox, credentials }),
        bootstrap: () => {
          const start = (host as Partial<ModalProvider>).startRuntime;
          if (!start) throw Error("modal_runtime_host_required");
          return (request) => start.call(host, request);
        },
      });
    },
  };
}
