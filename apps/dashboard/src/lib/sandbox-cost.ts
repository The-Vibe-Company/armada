import {
  type CredentialKind,
  costBasis,
  type Harness,
  type SandboxCost,
  type SandboxUsage,
  sandboxCost,
  type TurnTokenUsage,
} from "@armada/core";

/** The usage columns of a sandbox row, as row level security returns them to its owner and the org's admins. */
export type UsageColumns = {
  usage_turns?: unknown;
  usage_runtime_seconds?: number | null;
  usage_running_since?: string | null;
};

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The usage the server reports for a sandbox (`public.sandbox_usage`), read from its columns: compute time only for
 * completed intervals (an open one has no confirmed end), and the turns of the last collection. A malformed turn is
 * dropped, never guessed at.
 */
export function usageFromRow(row: UsageColumns): SandboxUsage {
  const runtime = typeof row.usage_runtime_seconds === "number" ? row.usage_runtime_seconds : null;
  const stored = record(row.usage_turns);
  const turns: TurnTokenUsage[] = [];
  for (const raw of Array.isArray(stored?.turns) ? stored.turns : []) {
    const turn = record(raw);
    if (!turn || typeof turn.promptId !== "string") continue;
    turns.push({
      promptId: turn.promptId,
      model: typeof turn.model === "string" ? turn.model : null,
      inputTokens: count(turn.inputTokens),
      outputTokens: count(turn.outputTokens),
      cachedTokens: count(turn.cachedTokens),
      cacheWriteTokens: count(turn.cacheWriteTokens),
    });
  }
  return {
    computeSeconds: runtime === null || row.usage_running_since ? null : runtime,
    turnCount: count(stored?.turnCount),
    turns,
  };
}

/** A sandbox's cost from its row and the kind of account it ran on (null when the viewer cannot read it). */
export function costOfRow(row: UsageColumns & { harness: Harness }, kind: CredentialKind | null): SandboxCost {
  return sandboxCost(usageFromRow(row), row.harness, costBasis(kind));
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** Dollars to the cent; a positive amount under a cent is "<$0.01", never "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return USD.format(usd);
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "950", "12.3K", "4.1M". */
export function formatTokens(tokens: number | null): string {
  return tokens === null ? "Not reported" : COMPACT.format(tokens);
}

export type CostFigure =
  | { kind: "none"; text: "No usage recorded yet" }
  | { kind: "unknown"; text: "Price unknown" | "Tokens not reported" }
  | { kind: "priced"; text: string; partial: boolean };

/**
 * The one figure a row or a card shows: nothing recorded, a price nobody can compute, or an amount. An amount that
 * leaves out unpriced turns is partial and says so where it is shown.
 */
export function costFigure(cost: SandboxCost): CostFigure {
  if (cost.turns.length === 0)
    return cost.turnCount > 0
      ? { kind: "unknown", text: "Tokens not reported" }
      : { kind: "none", text: "No usage recorded yet" };
  if (cost.usd === null)
    return {
      kind: "unknown",
      text: cost.turns.some((turn) => turn.unknown === "price") ? "Price unknown" : "Tokens not reported",
    };
  return {
    kind: "priced",
    text: formatUsd(cost.usd),
    partial: cost.unpricedTurns > 0 || Object.values(cost.tokens).some((tokens) => tokens === null),
  };
}

/** What a figure means, for a row's title: "Estimated cost" or "API-equivalent cost", with what it leaves out. */
export function costTitle(cost: SandboxCost): string {
  const figure = costFigure(cost);
  if (figure.kind !== "priced") return figure.text;
  const left = figure.partial
    ? cost.unpricedTurns > 0
      ? `, without ${cost.unpricedTurns} unpriced turn${cost.unpricedTurns === 1 ? "" : "s"}`
      : ", incomplete usage coverage"
    : "";
  return `${cost.label}${left}`;
}
