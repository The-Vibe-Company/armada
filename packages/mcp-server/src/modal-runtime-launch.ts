import type { LaunchOptions, Sql } from "@armada/core/server";
import { createRuntimeAgent } from "./runtime-agent.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { runtimeConfiguration } from "./runtime-configuration.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";
import { createRuntimeStartup } from "./runtime-startup.ts";

/** First-answer slice: same enrolled startup and journal, Modal supplies only compute. */
export function modalRuntimeLaunch(options: {
  sql: Sql;
  encryptionKey: string;
  serverUrl: string;
  manifest: unknown;
  architecture: "x64" | "arm64";
}): NonNullable<LaunchOptions["runtime"]> {
  const server = new URL(options.serverUrl);
  if (server.protocol !== "https:" || server.href !== `${server.origin}/`) throw Error("invalid_runtime_origin");
  const authority = createRuntimeEnrolments(options.sql, options.encryptionKey);
  const commands = createRuntimeCommands(authority, options.encryptionKey);
  return {
    async start({ host, actor, sandbox, credentials, signal, activate, restoreCheckpoint }) {
      if (host.id !== "modal" || sandbox.runtimeTransport !== "dialout") throw Error("runtime_selection_required");
      const { model, reasoningEffort } = sandbox;
      if (!model || !reasoningEffort) throw Error("runtime_model_required");
      const plan = await runtimeConfiguration({ ...options, actor, sandbox, credentials }, "modal");
      if (restoreCheckpoint)
        Object.assign(plan.configuration, { restoreCheckpoint: { ...restoreCheckpoint, model, reasoningEffort } });
      signal.throwIfAborted();
      await activate?.(signal);
      signal.throwIfAborted();
      const agent = createRuntimeAgent(commands, {
        harness: sandbox.harness,
        ownerId: actor.userId,
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        cwd: plan.configuration.cwd,
        defaults: { model, reasoningEffort },
      });
      const start = (
        host as typeof host & {
          startRuntime?: (input: {
            sandboxId: string;
            serverUrl: string;
            enrolmentToken: string;
            cacheDir: string;
            artifact: { sha256: string; bytes: number };
          }) => Promise<void>;
        }
      ).startRuntime;
      if (!start) throw Error("modal_runtime_host_required");
      const ready = await createRuntimeStartup(authority, {
        bootstrap: (input) => start.call(host, input),
        health: (admission) => agent.health(admission, restoreCheckpoint),
      })({
        ownerId: actor.userId,
        sandboxId: sandbox.id,
        providerSandboxId: sandbox.providerSandboxId,
        serverUrl: server.origin,
        ...plan,
        signal,
      });
      return { epoch: ready.epoch, prompt: (request) => agent.prompt(request, `launch_${sandbox.id}`, ready.epoch) };
    },
  };
}
