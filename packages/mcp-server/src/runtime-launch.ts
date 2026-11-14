import type { LaunchOptions, Sql } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import type { runtimeConfiguration } from "./runtime-configuration.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeStartup } from "./runtime-startup.ts";
import { runtimeWorkspace } from "./runtime-workspace.ts";

type LaunchInput = Parameters<NonNullable<LaunchOptions["runtime"]>["start"]>[0];
type Started = Awaited<ReturnType<NonNullable<LaunchOptions["runtime"]>["start"]>>;
type Bootstrap = Parameters<typeof createRuntimeStartup>[1]["bootstrap"];
type LaunchPlan = Awaited<ReturnType<typeof runtimeConfiguration>>;

export interface RuntimeLaunchOptions {
  sql: Sql;
  encryptionKey: string;
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
  github?: Pick<RuntimeGitHub, "prepareLaunch">;
}

/** One enrolled activation/readiness/session path; placement owns configuration and bootstrap transport. */
export function createRuntimeLaunch(options: RuntimeLaunchOptions) {
  requirePublishedRuntimeArchitecture(options.architecture);
  const server = new URL(options.serverUrl);
  if (server.protocol !== "https:" || server.href !== `${server.origin}/`) throw Error("invalid_runtime_origin");
  const authority = createRuntimeEnrolments(options.sql, options.encryptionKey);
  const commands = createRuntimeCommands(authority, options.encryptionKey);
  return async (request: {
    input: LaunchInput;
    configure(): Promise<LaunchPlan>;
    bootstrap(): Bootstrap;
  }): Promise<Started> => {
    const { input } = request;
    const { actor, sandbox, signal, activate, restoreCheckpoint } = input;
    const { model, reasoningEffort } = sandbox;
    if (!model || !reasoningEffort) throw Error("runtime_model_required");
    const plan = await request.configure();
    const defaults = { model, reasoningEffort };
    if (restoreCheckpoint)
      Object.assign(plan.configuration, { restoreCheckpoint: { ...restoreCheckpoint, ...defaults } });
    signal.throwIfAborted();
    await activate?.(signal);
    signal.throwIfAborted();
    const agent = runtimeAgentFor(commands, actor.userId, sandbox, defaults, plan.configuration.cwd);
    const ready = await createRuntimeStartup(authority, {
      bootstrap: request.bootstrap(),
      health: (admission) => agent.health(admission, restoreCheckpoint),
    })({
      ownerId: actor.userId,
      sandboxId: sandbox.id,
      providerSandboxId: sandbox.providerSandboxId,
      serverUrl: server.origin,
      ...plan,
      signal,
    });
    return {
      ...runtimeWorkspace(input, agent, ready.epoch, options.github),
      installSkills: (references, key) => agent.installSkills(references, key, ready.epoch, signal),
      epoch: ready.epoch,
      prompt: (request) => agent.prompt(request, `launch_${sandbox.id}`, ready.epoch),
    };
  };
}
