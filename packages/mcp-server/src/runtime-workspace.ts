import { type LaunchOptions, prepareLaunchWorkspace } from "@armada/core/server";
import type { runtimeAgentFor } from "./runtime-agent.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";

type Input = Parameters<NonNullable<LaunchOptions["runtime"]>["start"]>[0];
type Started = Awaited<ReturnType<NonNullable<LaunchOptions["runtime"]>["start"]>>;

/** Shared enrolled workspace policy. Hosts never execute setup through native ports. */
export function runtimeWorkspace(
  input: Pick<Input, "actor" | "signal"> & {
    host: Pick<Input["host"], "id" | "exec">;
    sandbox: Pick<Input["sandbox"], "id" | "providerSandboxId">;
    credentials: Pick<Input["credentials"], "secrets">;
  },
  agent: Pick<ReturnType<typeof runtimeAgentFor>, "workspaceHealth" | "workspaceExec">,
  epoch: string,
  github?: Pick<RuntimeGitHub, "prepareLaunch">,
): Pick<Started, "prepareWorkspace"> {
  const { host, actor, sandbox, credentials, signal } = input;
  return {
    prepareWorkspace: async (golden, progress, sleep) => {
      await agent.workspaceHealth(epoch, signal);
      const access = github
        ? await github.prepareLaunch(
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
      return access;
    },
  };
}
