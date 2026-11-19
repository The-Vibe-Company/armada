import type { LaunchOptions } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import { type LaunchStrategy, requireLaunchHeadroom } from "./launch-strategy.ts";
import { PrivateSkillError } from "./private-skill-error.ts";
import { launchInfrastructure } from "./sandbox-provider.ts";

export function runtimeLaunch(runtime: NonNullable<LaunchOptions["runtime"]>): LaunchStrategy {
  return {
    kind: "enrolled",
    forkEnv: () => ({}),
    recordFields: ({ provider }) =>
      launchInfrastructure(provider.id).nativeCli ? { boatRuntime: true } : { runtimeTransport: "dialout" },
    async initialize(plan, { actor, record, signal, progress, mark, runtimeStarted, reportGitHub }) {
      const { provider, stores, request, options, golden, credentials } = plan;
      progress("initialization_hydrate");
      progress("initialization_github");
      progress("initialization_cwd");
      progress("initialization_mcp");
      requireLaunchHeadroom(record);
      const agent = await Promise.resolve().then(() =>
        runtime.start({ host: provider, actor, sandbox: record, credentials, signal }),
      );
      runtimeStarted();
      if (!agent || typeof agent.prompt !== "function" || !/^[1-9][0-9]{0,18}$/.test(agent.epoch))
        throw new LaunchError("start_failed", "The runtime did not acknowledge a valid epoch.");
      if (!agent.prepareWorkspace)
        throw new LaunchError(
          "start_failed",
          "Runtime workspace setup requires updated runtime artifacts; no native fallback.",
        );
      const github = await agent.prepareWorkspace(golden, progress, options.sleep);
      await mark("checkout_done");
      if (request.skills?.length) {
        if (!agent.installSkills) throw new PrivateSkillError("skillpack_transport_failed", "transport");
        const needsKey = request.skills.some((ref) => !ref.includes("/"));
        const key = needsKey ? ((await stores.credentials.skillpackKey?.(actor)) ?? null) : null;
        if (needsKey && !key) throw new PrivateSkillError("skillpack_credential_missing", "credential");
        try {
          record.skills = await agent.installSkills(request.skills, key);
        } catch (error) {
          if (
            error instanceof PrivateSkillError &&
            error.reason === "skillpack_cli_unavailable" &&
            golden.buildWarnings?.includes("skillpack_download_unavailable")
          )
            throw new PrivateSkillError("skillpack_download_unavailable", error.stage);
          throw error;
        }
        await stores.sandboxes.recordSkills!(record.id, record.skills);
      }
      await stores.connections?.prepare?.(provider, record, actor, signal);
      await options.beforeStart?.(provider, record);
      reportGitHub(github);
      return { github, prompt: (request) => agent.prompt(request), runtime: { kind: "armada", epoch: agent.epoch } };
    },
  };
}
