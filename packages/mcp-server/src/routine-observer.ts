import type { DockerSandboxStatus, Provider } from "@armada/core";
import { promptOutcome, type RoutineTaskState } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { SandboxView } from "./data.ts";
import type { createDockerSandboxControls } from "./docker-sandbox-controls.ts";

/** Observe only the scheduled initial prompt, using Docker's authorized retained history. */
export async function observeRoutinePrompt(
  caller: Caller,
  turn: { sandboxId: string; promptId: string; conversationId?: string | null },
  ports: {
    docker?: Pick<ReturnType<typeof createDockerSandboxControls>, "invoke">;
    get(id: string): Promise<SandboxView | null>;
    provider(sandbox: SandboxView): Promise<Provider>;
  },
): Promise<RoutineTaskState> {
  const docker = await ports.docker?.invoke(caller, "status", { id: turn.sandboxId, prompt_id: turn.promptId });
  if (docker?.handled) {
    const state = (docker.result as DockerSandboxStatus).prompt?.state;
    return state === "queued" ? "running" : (state ?? "unknown");
  }
  const sandbox = await ports.get(turn.sandboxId);
  if (!sandbox || sandbox.status === "deleted") return "unknown";
  const result = await promptOutcome(await ports.provider(sandbox), {
    sandboxId: sandbox.providerSandboxId,
    promptId: turn.promptId,
    ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
  });
  return result.state;
}
