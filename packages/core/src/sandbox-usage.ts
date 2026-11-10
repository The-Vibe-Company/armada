import type { AgentEvent } from "./provider.ts";

export interface TurnTokenUsage {
  promptId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}
export interface SandboxUsage {
  /** Seconds between Armada-recorded compute transitions; null for legacy/incomplete history. */
  computeSeconds: number | null;
  turnCount: number | null;
  turns: TurnTokenUsage[];
  tokenTotals?: TokenUsageTotals;
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
          cacheWriteTokens: count(usage.cacheCreationInputTokens),
          reasoningTokens: count(usage.reasoningTokens),
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
        cacheWriteTokens: count(data.cacheWriteTokens),
        reasoningTokens: count(data.reasoningTokens),
      });
    }
  }
  return { turnCount: prompts.size, turns: [...rows.values()] };
}

export interface TokenUsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}
export interface SandboxUsageSummary extends TokenUsageTotals {
  computeSeconds: number | null;
  turnCount: number | null;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;

/** A missing turn/field makes that total unknown, not a falsely complete subtotal. */
export function summarizeSandboxUsage(usage: SandboxUsage | null | undefined): SandboxUsageSummary {
  const complete =
    usage?.turnCount !== null &&
    usage?.turnCount !== undefined &&
    new Set(usage.turns.map((turn) => turn.promptId)).size === usage.turnCount;
  const tokens = Object.fromEntries(
    TOKEN_FIELDS.map((key) => {
      const values = usage?.turns.map((turn) => count(turn[key])) ?? [];
      const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
      return [key, complete && values.every((value) => value !== null) && Number.isSafeInteger(sum) ? sum : null];
    }),
  ) as unknown as TokenUsageTotals;
  return { ...tokens, computeSeconds: usage?.computeSeconds ?? null, turnCount: usage?.turnCount ?? null };
}

/** Add totals at read time, including persisted observations predating these fields. */
export function withUsageTotals(usage: SandboxUsage | null | undefined): SandboxUsage | null {
  if (!usage) return null;
  const { computeSeconds: _compute, turnCount: _turns, ...tokenTotals } = summarizeSandboxUsage(usage);
  return { ...usage, tokenTotals };
}

/** Empty child sets cost zero; any unknown component keeps that component unknown. */
export function sumSandboxUsage(usages: readonly (SandboxUsage | null)[]): SandboxUsageSummary {
  const rows = usages.map(summarizeSandboxUsage);
  return Object.fromEntries(
    ([...TOKEN_FIELDS, "computeSeconds", "turnCount"] as const).map((key) => {
      const values = rows.map((row) => row[key]);
      const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
      return [
        key,
        values.every((value) => value !== null) &&
        (key === "computeSeconds" ? Number.isFinite(sum) : Number.isSafeInteger(sum))
          ? sum
          : null,
      ];
    }),
  ) as unknown as SandboxUsageSummary;
}
