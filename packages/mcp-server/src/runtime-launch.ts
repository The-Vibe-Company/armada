import type { LaunchOptions, ModelChoice, Sql } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeStartup } from "./runtime-startup.ts";

type LaunchInput = Parameters<NonNullable<LaunchOptions["runtime"]>["start"]>[0];
type Started = Awaited<ReturnType<NonNullable<LaunchOptions["runtime"]>["start"]>>;
type Bootstrap = Parameters<typeof createRuntimeStartup>[1]["bootstrap"];

export interface RuntimeLaunchOptions {
  sql: Sql;
  encryptionKey: string;
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
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
    plan: { cacheDir: string; artifact: { sha256: string; bytes: number }; configuration: { cwd: string } };
    defaults: ModelChoice;
    bootstrap(): Bootstrap;
    extensions?(agent: ReturnType<typeof createRuntimeAgent>, epoch: string): Pick<Started, "prepareWorkspace">;
  }): Promise<Started> => {
    const { input, plan, defaults } = request;
    const { actor, sandbox, signal, activate, restoreCheckpoint } = input;
    if (restoreCheckpoint)
      Object.assign(plan.configuration, { restoreCheckpoint: { ...restoreCheckpoint, ...defaults } });
    signal.throwIfAborted();
    await activate?.(signal);
    signal.throwIfAborted();
    const agent = createRuntimeAgent(commands, {
      harness: sandbox.harness,
      ownerId: actor.userId,
      sandboxId: sandbox.id,
      providerSandboxId: sandbox.providerSandboxId,
      cwd: plan.configuration.cwd,
      defaults,
    });
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
      ...request.extensions?.(agent, ready.epoch),
      installSkills: (references, key) => agent.installSkills(references, key, ready.epoch, signal),
      epoch: ready.epoch,
      prompt: (request) => agent.prompt(request, `launch_${sandbox.id}`, ready.epoch),
    };
  };
}
