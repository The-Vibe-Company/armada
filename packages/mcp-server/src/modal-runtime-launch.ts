import type { LaunchOptions } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { modalRuntimeConfiguration } from "./modal-runtime-variables.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";

/** First-answer slice: same enrolled startup and journal, Modal supplies only compute. */
export function modalRuntimeLaunch(options: RuntimeLaunchOptions): NonNullable<LaunchOptions["runtime"]> {
  const startRuntime = createRuntimeLaunch(options);
  return {
    async start(input) {
      const { host, actor, sandbox, credentials } = input;
      if (host.id !== "modal" || sandbox.runtimeTransport !== "dialout") throw Error("runtime_selection_required");
      const { model, reasoningEffort } = sandbox;
      if (!model || !reasoningEffort) throw Error("runtime_model_required");
      const plan = await modalRuntimeConfiguration(options.sql, { ...options, actor, sandbox, credentials });
      // Restored native sessions cannot resurrect old upstream defaults before current-epoch delivery.
      Object.assign(plan.configuration, { mcp: { revision: "modal_runtime_empty_v1", servers: {} } });
      return startRuntime({
        input,
        plan,
        defaults: { model, reasoningEffort },
        bootstrap: () => {
          const start = (host as Partial<ModalProvider>).startRuntime;
          if (!start) throw Error("modal_runtime_host_required");
          return (request) => start.call(host, request);
        },
      });
    },
  };
}
