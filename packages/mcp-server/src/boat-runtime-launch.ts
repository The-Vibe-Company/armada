import { type LaunchOptions, prepareLaunchWorkspace } from "@armada/core/server";
import { startBoatRuntime } from "@armada/provider-boat";
import { boatRuntimeConfiguration } from "./boat-runtime-configuration.ts";
import { createRuntimeLaunch, type RuntimeLaunchOptions } from "./runtime-launch.ts";

/** Build policy once; choose it explicitly for a launch, never as a native fallback.
 * Manifest/origin are trusted server deployment inputs, not client parameters.
 */
export function boatRuntimeLaunch(
  options: RuntimeLaunchOptions & {
    github?: Pick<import("./runtime-github.ts").RuntimeGitHub, "prepareLaunch">;
    modelAuth?: Parameters<typeof boatRuntimeConfiguration>[0]["modelAuth"];
  },
): NonNullable<LaunchOptions["boatRuntime"]> {
  const startRuntime = createRuntimeLaunch(options);
  const manifest = structuredClone(options.manifest);
  const { architecture, modelAuth } = options;
  return {
    async start(input) {
      const { host, actor, sandbox, credentials, signal } = input;
      if (sandbox.boatRuntime !== true || host.id !== "boat") throw Error("runtime_selection_required");
      return startRuntime({
        input,
        configure: () =>
          boatRuntimeConfiguration({
            actor,
            sandbox,
            credentials,
            manifest,
            architecture,
            ...(modelAuth ? { modelAuth } : {}),
          }),
        bootstrap: () => (request) => startBoatRuntime(host, request),
        extensions: (agent, epoch) => ({
          prepareWorkspace: async (golden, progress, sleep) => {
            await agent.workspaceHealth(epoch, signal);
            const github = options.github
              ? await options.github.prepareLaunch(
                  { userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }], via: "service" },
                  sandbox.id,
                )
              : { status: "not_connected" as const, message: "GitHub is not configured." };
            await prepareLaunchWorkspace(
              host,
              sandbox.providerSandboxId,
              sandbox.id,
              golden,
              credentials.secrets,
              progress,
              sleep,
              (request, step) => agent.workspaceExec(request, step, epoch, signal),
            );
            return github;
          },
        }),
      });
    },
  };
}
