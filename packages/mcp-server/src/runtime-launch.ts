import type { LaunchOptions, Sql } from "@armada/core/server";
import { requirePublishedRuntimeArchitecture } from "../../agent-runtime/src/publication.ts";
import { createGoldenRuntimeEnvironment } from "./golden-runtime-environment.ts";
import { runtimeAgentFor } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import type { runtimeConfiguration } from "./runtime-configuration.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import type { RuntimeGitHub } from "./runtime-github.ts";
import { createRuntimeStartup } from "./runtime-startup.ts";
import { runtimeWorkspace } from "./runtime-workspace.ts";

type LaunchPolicy = NonNullable<LaunchOptions["runtime"]>;
type LaunchInput = Parameters<LaunchPolicy["start"]>[0] & {
  assertDispatch?: (tx?: Sql) => Promise<void>;
  assertBeforeTicket?: (tx: Sql) => Promise<void>;
};
export type RuntimeLaunchPolicy = Omit<LaunchPolicy, "start"> & {
  start(input: LaunchInput): ReturnType<LaunchPolicy["start"]>;
};
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
export function createRuntimeLaunch(options: RuntimeLaunchOptions, provider: "boat" | "modal") {
  requirePublishedRuntimeArchitecture(options.architecture);
  const server = new URL(options.serverUrl);
  if (server.protocol !== "https:" || server.href !== `${server.origin}/`) throw Error("invalid_runtime_origin");
  const authority = createRuntimeEnrolments(options.sql, options.encryptionKey);
  const commands = createRuntimeCommands(authority, options.encryptionKey);
  const environment = createGoldenRuntimeEnvironment(options.sql, options.encryptionKey);
  return async (request: {
    input: LaunchInput;
    configure(): Promise<LaunchPlan>;
    bootstrap(): Bootstrap;
    commandGrantDeadline?(logicalExpiresAt: number): Promise<number>;
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
    const commandGrantExpiresAt = await request.commandGrantDeadline?.(plan.configuration.grant.expiresAt);
    signal.throwIfAborted();
    if (commandGrantExpiresAt !== undefined) plan.configuration.grant.expiresAt = commandGrantExpiresAt;
    const agent = runtimeAgentFor(commands, actor.userId, sandbox, defaults, plan.configuration.cwd);
    const ready = await createRuntimeStartup(authority, {
      bootstrap: request.bootstrap(),
      health: (admission, epoch) =>
        agent.health(
          admission,
          restoreCheckpoint,
          input.assertDispatch ? { expectedEpoch: epoch, assertClaim: input.assertDispatch } : undefined,
        ),
    })({
      ownerId: actor.userId,
      sandboxId: sandbox.id,
      providerSandboxId: sandbox.providerSandboxId,
      serverUrl: server.origin,
      ...plan,
      ...(sandbox.lifecycleGeneration === undefined ? {} : { expectedGeneration: sandbox.lifecycleGeneration }),
      ...(commandGrantExpiresAt !== undefined ? { commandGrantExpiresAt } : {}),
      ...(input.assertDispatch ? { assertClaim: input.assertDispatch } : {}),
      ...(input.assertBeforeTicket ? { assertBeforeTicket: input.assertBeforeTicket } : {}),
      signal,
    });
    await environment.deliver(provider, actor, sandbox.id, ready.epoch, signal, input.assertDispatch);
    return {
      ...runtimeWorkspace(input, agent, ready.epoch, options.github),
      installScopedReference: (request) =>
        agent.workspaceExec(request, { phase: "init", index: 100, attempt: 0 }, ready.epoch, signal),
      installSkills: (references, key) => agent.installSkills(references, key, ready.epoch, signal),
      epoch: ready.epoch,
      prompt: (request) => agent.prompt(request, `launch_${sandbox.id}`, ready.epoch),
    };
  };
}
