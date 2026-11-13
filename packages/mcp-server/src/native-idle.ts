import { isFinalPromptStatus, type Provider, type SandboxInfo } from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import { runtimeIdle } from "./runtime-idle.ts";

/** Native observation only: never interrupts or resumes compute to prove quiescence. */
export async function nativeQuiescent(provider: Provider, info: SandboxInfo, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (provider.id === "boat") {
    const native = provider as Provider & Partial<Pick<BoatProvider, "conversations">>;
    if (!native.conversations) return false;
    const conversations = await native.conversations(info.id);
    signal?.throwIfAborted();
    return conversations.every((conversation) => conversation.running === false);
  }
  if (provider.id !== "modal" || !info.physicalGeneration || !provider.observeOrchestrator) return false;
  const observed = await provider.observeOrchestrator({
    sandboxId: info.id,
    physicalGeneration: info.physicalGeneration,
  });
  signal?.throwIfAborted();
  return (
    observed.physicalGeneration === info.physicalGeneration &&
    observed.state === "quiescent" &&
    observed.eventWatermark === observed.acknowledgedSequence
  );
}

/** Bounded recent history must contain this admitted turn's terminal event.
 * A missing event/port, queued/running turn or unknown native state stays live. */
export async function nativeIdleDue(
  provider: Provider,
  info: SandboxInfo,
  taskPromptId: string | null,
  now: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!taskPromptId || !["ready", "running"].includes(info.state)) return false;
  if (!(await nativeQuiescent(provider, info, signal))) return false;
  signal?.throwIfAborted();
  const turn = await provider.getPrompt({ sandboxId: info.id, promptId: taskPromptId, ...(signal ? { signal } : {}) });
  if (turn.promptId !== taskPromptId || !turn.done || !isFinalPromptStatus(turn.status)) return false;
  signal?.throwIfAborted();
  const page = await provider.events({
    sandboxId: info.id,
    direction: "backward",
    limit: 200,
    ...(signal ? { signal } : {}),
  });
  if (
    !page.events.some(
      (event) => event.kind === "prompt" && event.promptId === taskPromptId && isFinalPromptStatus(event.status),
    )
  )
    return false;
  return runtimeIdle(page.events, now, delayMs) && (await nativeQuiescent(provider, info, signal));
}
