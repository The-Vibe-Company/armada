import type { LaunchOptions, Sql } from "@armada/core/server";
import { startBoatRuntime } from "@armada/provider-boat";
import { boatRuntimeConfiguration } from "./boat-runtime-configuration.ts";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeStartup } from "./runtime-startup.ts";

/** Build policy once; choose it explicitly for a launch, never as a native fallback.
 * Manifest/origin are trusted server deployment inputs, not client parameters.
 */
export function boatRuntimeLaunch(options: {
  sql: Sql;
  encryptionKey: string;
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
  modelAuth?: Parameters<typeof boatRuntimeConfiguration>[0]["modelAuth"];
}): NonNullable<LaunchOptions["boatRuntime"]> {
  const server = new URL(options.serverUrl);
  if (server.protocol !== "https:" || server.href !== `${server.origin}/`) throw Error("invalid_runtime_origin");
  const manifest = structuredClone(options.manifest);
  const { architecture, modelAuth } = options;
  const authority = createRuntimeEnrolments(options.sql, options.encryptionKey);
  const commands = createRuntimeCommands(authority, options.encryptionKey);
  return {
    async start({ host, actor, sandbox, credentials, signal, activate, restoreCheckpoint }) {
      if (sandbox.boatRuntime !== true || host.id !== "boat") throw Error("runtime_selection_required");
      const { model, reasoningEffort } = sandbox;
      if (!model || !reasoningEffort) throw Error("runtime_model_required");
      const plan = await boatRuntimeConfiguration({
        actor,
        sandbox,
        credentials,
        manifest,
        architecture,
        ...(modelAuth ? { modelAuth } : {}),
      });
      if (restoreCheckpoint)
        Object.assign(plan.configuration, { restoreCheckpoint: { ...restoreCheckpoint, model, reasoningEffort } });
      signal.throwIfAborted();
      await activate?.(signal);
      signal.throwIfAborted();
      const agent = createRuntimeAgent(commands, {
        ownerId: actor.userId,
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        cwd: plan.configuration.cwd,
        defaults: { model, reasoningEffort },
      });
      const ready = await createRuntimeStartup(authority, {
        bootstrap: (input) => startBoatRuntime(host, input),
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
        installSkills: (references, key) => agent.installSkills(references, key, ready.epoch, signal),
        epoch: ready.epoch,
        prompt: (request) => agent.prompt(request, `launch_${sandbox.id}`, ready.epoch),
      };
    },
  };
}
