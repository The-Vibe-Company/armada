import { type LaunchOptions, prepareLaunchWorkspace, type Sql } from "@armada/core/server";
import type { runtimeAgentFor } from "./runtime-agent.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";

type Input = Parameters<NonNullable<LaunchOptions["runtime"]>["start"]>[0];
type PrepareWorkspace = NonNullable<
  Awaited<ReturnType<NonNullable<LaunchOptions["runtime"]>["start"]>>["prepareWorkspace"]
>;

/** Shared enrolled workspace policy. Hosts never execute setup through native ports. */
export function runtimeWorkspace(
  input: Pick<Input, "actor" | "signal"> & {
    host: Pick<Input["host"], "id">;
    sandbox: Pick<Input["sandbox"], "id" | "providerSandboxId">;
    credentials: Pick<Input["credentials"], "secrets">;
  },
  agent: Pick<ReturnType<typeof runtimeAgentFor>, "workspaceHealth" | "workspaceExec">,
  epoch: string,
  github?: Pick<RuntimeGitHub, "prepareLaunch">,
  options?: { assertClaim: (tx: Sql) => Promise<void>; trackPushes: boolean; healthRequestId: string },
): {
  prepareWorkspace: (
    golden: Pick<Parameters<PrepareWorkspace>[0], "config">,
    ...args: [progress: Parameters<PrepareWorkspace>[1], sleep?: Parameters<PrepareWorkspace>[2]]
  ) => ReturnType<PrepareWorkspace>;
} {
  const { host, actor, sandbox, credentials, signal } = input;
  return {
    prepareWorkspace: async (golden, progress, sleep) => {
      await agent.workspaceHealth(epoch, signal, options?.healthRequestId);
      const access = github
        ? await github.prepareLaunch(
            { userId: actor.userId, orgs: [{ orgId: actor.orgId, role: actor.role }], via: "service" },
            sandbox.id,
            options?.assertClaim,
          )
        : { status: "not_connected" as const, message: "GitHub is not configured." };
      const warnings = await prepareLaunchWorkspace(
        {
          id: host.id,
          exec: async () => {
            throw new Error("Runtime workspace transport required.");
          },
        },
        sandbox.providerSandboxId,
        sandbox.id,
        golden,
        credentials.secrets,
        progress,
        sleep,
        (request, step) => agent.workspaceExec(request, step, epoch, signal),
        options?.trackPushes ?? access.status === "connected",
      );
      return warnings.length ? { ...access, message: [access.message, ...warnings].filter(Boolean).join(" ") } : access;
    },
  };
}
