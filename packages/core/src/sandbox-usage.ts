import type { AgentEvent } from "./provider.ts";

export interface TurnTokenUsage {
  promptId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
}
export interface SandboxUsage {
  /** Seconds between Armada-recorded compute transitions; null for legacy/incomplete history. */
  computeSeconds: number | null;
  turnCount: number | null;
  turns: TurnTokenUsage[];
}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Native final snapshots only, never deltas or account quota reports. */
export function reportedTurnUsage(events: readonly AgentEvent[]): { turnCount: number; turns: TurnTokenUsage[] } {
  const prompts = new Set<string>();
  const rows = new Map<string, TurnTokenUsage>();
  for (const event of events) {
    if (!event.promptId) continue;
    if (event.kind === "prompt") prompts.add(event.promptId);
    if (event.kind !== "other") continue;
    const data = object(event.data);
    if (!data) continue;
    if (event.type === "result") {
      const models = object(data.modelUsage);
      if (!models) continue;
      for (const [model, raw] of Object.entries(models)) {
        const usage = object(raw);
        if (!usage) continue;
        rows.set(JSON.stringify([event.promptId, model]), {
          promptId: event.promptId,
          model,
          inputTokens: count(usage.inputTokens),
          outputTokens: count(usage.outputTokens),
          cachedTokens: count(usage.cacheReadInputTokens),
        });
      }
    } else if (event.type === "armada/turnUsage") {
      const model = typeof data.model === "string" ? data.model : null;
      rows.set(JSON.stringify([event.promptId, model]), {
        promptId: event.promptId,
        model,
        inputTokens: count(data.inputTokens),
        outputTokens: count(data.outputTokens),
        cachedTokens: count(data.cachedTokens),
      });
    }
  }
  return { turnCount: prompts.size, turns: [...rows.values()] };
}
