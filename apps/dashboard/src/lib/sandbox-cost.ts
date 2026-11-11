import {
  type CredentialKind,
  combineCosts,
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
  return { kind: "priced", text: formatUsd(cost.usd), partial: cost.unpricedTurns > 0 };
}

/** What a figure means, for a row's title: "Estimated cost" or "API-equivalent cost", with what it leaves out. */
export function costTitle(cost: SandboxCost): string {
  const figure = costFigure(cost);
  if (figure.kind !== "priced") return figure.text;
  const left = figure.partial
    ? `, without ${cost.unpricedTurns} unpriced turn${cost.unpricedTurns === 1 ? "" : "s"}`
    : "";
  return `${cost.label}${left}`;
}

/** An orchestrator's cost: its own sandbox's, each worker's, and the two together. Plain data, for a client component. */
export type OrchestratorCost = {
  /** Its own and its readable workers' together. */
  total: SandboxCost;
  /** Its own sandbox's, or null when it has none or its row is not readable. */
  own: SandboxCost | null;
  /** Its readable workers' together. */
  workers: SandboxCost;
  /** The workers whose row the viewer could read, by id: any other is left out of the figures. */
  children: Record<string, SandboxCost>;
};

export function orchestratorCost(
  ownId: string | null,
  childIds: readonly string[],
  costs: ReadonlyMap<string, SandboxCost>,
): OrchestratorCost {
  const own = ownId ? (costs.get(ownId) ?? null) : null;
  const children: Record<string, SandboxCost> = {};
  for (const id of new Set(childIds)) {
    const cost = costs.get(id);
    if (cost) children[id] = cost;
  }
  return {
    total: combineCosts([...(own ? [own] : []), ...Object.values(children)]),
    own,
    workers: combineCosts(Object.values(children)),
    children,
  };
}

/**
 * Its cost (#875): its own and its workers' together, labelled by what the figure means, then each part. The figures
 * were read with the page; a worker launched since, or one the viewer cannot read, is not counted: the label says how
 * many and the amounts read "≥". Nothing recorded reads "No usage yet", never $0.00.
 */
export function orchestratorCostRows(cost: OrchestratorCost, liveChildren: readonly string[]): [string, string][] {
  const workers = [...new Set(liveChildren)];
  const missing = workers.filter((id) => !Object.hasOwn(cost.children, id)).length;
  const text = (part: SandboxCost | null, lower: boolean) => {
    if (!part) return "No usage yet";
    const figure = costFigure(part);
    if (figure.kind === "none") return "No usage yet";
    if (figure.kind !== "priced") return figure.text;
    return figure.partial || lower ? `≥ ${figure.text}` : figure.text;
  };
  const counted = workers.length - missing;
  const label = `Its ${workers.length} worker${workers.length === 1 ? "" : "s"}${missing > 0 ? `, ${missing} not counted` : ""}`;
  return [
    // Nothing counted while some workers are not: the total is unknown, not "No usage yet".
    [
      cost.total.label,
      missing > 0 && costFigure(cost.total).kind === "none" ? "Not counted" : text(cost.total, missing > 0),
    ],
    ["Its own", text(cost.own, false)],
    [label, workers.length === 0 ? "None yet" : counted === 0 ? "Not counted" : text(cost.workers, missing > 0)],
  ];
}
