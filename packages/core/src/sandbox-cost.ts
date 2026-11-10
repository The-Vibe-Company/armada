import type { CredentialKind } from "./database.types.ts";
import { type ModelPrice, modelPrice } from "./model-prices.ts";
import type { SandboxUsage, TurnTokenUsage } from "./sandbox-usage.ts";

/**
 * What a cost figure means. A subscription account (Claude Code login, Codex auth.json) has no per-token bill: its
 * figure is what the same tokens would cost on the API. An API-key account is billed per token: its figure is an
 * estimate from list prices. Neither is ever what was paid.
 */
export type CostBasis = "api_equivalent" | "estimated";

export const COST_BASIS_LABELS: Readonly<Record<CostBasis, string>> = {
  api_equivalent: "API-equivalent cost",
  estimated: "Estimated cost",
};

const SUBSCRIPTION_KINDS: readonly CredentialKind[] = ["claude_oauth", "codex_auth"];

/** The basis of a sandbox's figure from the kind of account it ran on; an account the viewer cannot read is "estimated". */
export function costBasis(kind: CredentialKind | null | undefined): CostBasis {
  return kind && SUBSCRIPTION_KINDS.includes(kind) ? "api_equivalent" : "estimated";
}

export interface TurnCost {
  promptId: string;
  model: string | null;
  /** Input tokens not read from the cache; null when the harness did not report them. */
  inputTokens: number | null;
  /** Input tokens read from the cache. */
  cachedTokens: number | null;
  outputTokens: number | null;
  /** USD, or null when the model has no price or a counter is missing. */
  usd: number | null;
  /** Why `usd` is null. */
  unknown: "price" | "tokens" | null;
}

export interface SandboxCost {
  basis: CostBasis;
  label: string;
  turns: TurnCost[];
  /** Prompts sent, from the server's count; else the distinct prompts with reported tokens. */
  turnCount: number;
  computeSeconds: number | null;
  /** Sums over the turns that reported each counter. */
  tokens: { input: number; cached: number; output: number };
  /** The sum of the priced turns, or null when no turn could be priced. */
  usd: number | null;
  /** Turns whose cost is unknown: the total leaves them out. */
  unpricedTurns: number;
  /** Distinct reported models, in order of first use. */
  models: string[];
}

const PER_MILLION = 1_000_000;

/**
 * The cost of one turn. The harnesses count cached input differently: Claude's input excludes cache reads, Codex's
 * cached input is part of its input. Both are brought to "uncached input + cache reads" before pricing. Cache writes
 * are not reported by either harness, so they are not counted.
 */
export function turnCost(turn: TurnTokenUsage): TurnCost {
  const price = modelPrice(turn.model);
  const reported = turn.inputTokens !== null && turn.outputTokens !== null && turn.cachedTokens !== null;
  const cached =
    turn.cachedTokens === null
      ? null
      : price?.vendor === "openai" && turn.inputTokens !== null
        ? Math.min(turn.cachedTokens, turn.inputTokens)
        : turn.cachedTokens;
  const input =
    turn.inputTokens === null ? null : price?.vendor === "openai" ? turn.inputTokens - (cached ?? 0) : turn.inputTokens;
  const base = { promptId: turn.promptId, model: turn.model, inputTokens: input, cachedTokens: cached };
  if (!price) return { ...base, outputTokens: turn.outputTokens, usd: null, unknown: "price" };
  if (!reported) return { ...base, outputTokens: turn.outputTokens, usd: null, unknown: "tokens" };
  return {
    ...base,
    outputTokens: turn.outputTokens,
    usd: priced(price, input ?? 0, cached ?? 0, turn.outputTokens ?? 0),
    unknown: null,
  };
}

function priced(price: ModelPrice, input: number, cached: number, output: number): number {
  return (input * price.input + cached * price.cacheRead + output * price.output) / PER_MILLION;
}

/** The cost of a sandbox from its reported usage. Null usage (never collected, or not visible) costs nothing known. */
export function sandboxCost(usage: SandboxUsage | null, basis: CostBasis): SandboxCost {
  const turns = (usage?.turns ?? []).map(turnCost);
  const tokens = { input: 0, cached: 0, output: 0 };
  let usd: number | null = null;
  let unpricedTurns = 0;
  const models: string[] = [];
  for (const turn of turns) {
    tokens.input += turn.inputTokens ?? 0;
    tokens.cached += turn.cachedTokens ?? 0;
    tokens.output += turn.outputTokens ?? 0;
    if (turn.usd === null) unpricedTurns += 1;
    else usd = (usd ?? 0) + turn.usd;
    if (turn.model && !models.includes(turn.model)) models.push(turn.model);
  }
  return {
    basis,
    label: COST_BASIS_LABELS[basis],
    turns,
    turnCount: usage?.turnCount ?? new Set(turns.map((turn) => turn.promptId)).size,
    computeSeconds: usage?.computeSeconds ?? null,
    tokens,
    usd,
    unpricedTurns,
    models,
  };
}
