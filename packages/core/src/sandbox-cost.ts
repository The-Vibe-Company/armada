import type { Harness } from "./contract.ts";
import type { CredentialKind } from "./database.types.ts";
import { modelPrice } from "./model-prices.ts";
import type { SandboxUsage, TurnTokenUsage } from "./sandbox-usage.ts";

/**
 * What a cost figure means. An API-key account is billed per token: its figure is an estimate from list prices. A
 * subscription account (Claude Code login, Codex auth.json) has no per-token bill: its figure is what the same tokens
 * would cost on the API. Neither is ever what was paid.
 */
export type CostBasis = "api_equivalent" | "estimated";

export const COST_BASIS_LABELS: Readonly<Record<CostBasis, string>> = {
  api_equivalent: "API-equivalent cost",
  estimated: "Estimated cost",
};

const API_KEY_KINDS: readonly CredentialKind[] = ["anthropic", "openai"];

/**
 * The basis of a sandbox's figure from the kind of account it ran on. Only a known API key is "estimated": an account
 * the viewer cannot read (an admin looking at a member's personal login, a removed account) is "API-equivalent", which
 * is true of any account.
 */
export function costBasis(kind: CredentialKind | null | undefined): CostBasis {
  return kind && API_KEY_KINDS.includes(kind) ? "estimated" : "api_equivalent";
}

export interface TurnCost {
  promptId: string;
  model: string | null;
  /** Native reported input: Codex includes cache reads/writes; Claude excludes them. */
  inputTokens: number | null;
  /** Input tokens read from the cache. */
  cachedTokens: number | null;
  outputTokens: number | null;
  /** Tokens written to the prompt cache; null when not reported. */
  cacheWriteTokens: number | null;
  /** USD, or null when the model has no price or a counter was not reported. */
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
  /** Totals are null when any counter or prompt coverage is missing. */
  tokens: { input: number | null; cached: number | null; cacheWrite: number | null; output: number | null };
  /** The sum of the priced turns, or null when no turn could be priced. */
  usd: number | null;
  /** Turns (prompts) with at least one model whose cost is unknown: the total leaves those out. */
  unpricedTurns: number;
  /** Distinct reported models, in order of first use. */
  models: string[];
}

const PER_MILLION = 1_000_000;

/**
 * The cost of one model's share of a turn. The harnesses count cached input differently (docs/sandbox-usage.md):
 * Claude's input excludes cache reads, Codex's cached input is part of its input. Both are brought to "uncached input
 * + cache reads + cache writes" by harness for pricing only. Displayed counters keep their native semantics
 * independently of pricing completeness. Missing counters are never priced as zero.
 */
export function turnCost(turn: TurnTokenUsage, harness: Harness): TurnCost {
  const price = modelPrice(turn.model);
  const subset = harness === "codex";
  const cached = turn.cachedTokens;
  const cacheWrite = turn.cacheWriteTokens ?? null;
  const input =
    turn.inputTokens === null
      ? null
      : subset
        ? cached === null || cacheWrite === null || cached + cacheWrite > turn.inputTokens
          ? null
          : turn.inputTokens - cached - cacheWrite
        : turn.inputTokens;
  const base = {
    promptId: turn.promptId,
    model: turn.model,
    inputTokens: turn.inputTokens,
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: turn.outputTokens,
  };
  if (!price) return { ...base, usd: null, unknown: "price" };
  if (input === null || cached === null || cacheWrite === null || turn.outputTokens === null)
    return { ...base, usd: null, unknown: "tokens" };
  return {
    ...base,
    usd:
      (input * price.input +
        cached * price.cacheRead +
        cacheWrite * price.cacheWrite +
        turn.outputTokens * price.output) /
      PER_MILLION,
    unknown: null,
  };
}

const add = (a: number | null, b: number | null): number | null => {
  if (a === null || b === null) return null;
  const total = a + b;
  return Number.isSafeInteger(total) ? total : null;
};

/** The cost of a sandbox from its reported usage. Null usage (never collected, or not visible) costs nothing known. */
export function sandboxCost(usage: SandboxUsage | null, harness: Harness, basis: CostBasis): SandboxCost {
  const turns = (usage?.turns ?? []).map((turn) => turnCost(turn, harness));
  const complete = usage?.turnCount != null && new Set(turns.map((turn) => turn.promptId)).size === usage.turnCount;
  const tokens: SandboxCost["tokens"] = {
    input: complete ? 0 : null,
    cached: complete ? 0 : null,
    cacheWrite: complete ? 0 : null,
    output: complete ? 0 : null,
  };
  let usd: number | null = null;
  const unpriced = new Set<string>();
  const missing = Math.max(0, (usage?.turnCount ?? 0) - new Set(turns.map((turn) => turn.promptId)).size);
  const models: string[] = [];
  for (const turn of turns) {
    tokens.input = add(tokens.input, turn.inputTokens);
    tokens.cached = add(tokens.cached, turn.cachedTokens);
    tokens.cacheWrite = add(tokens.cacheWrite, turn.cacheWriteTokens);
    tokens.output = add(tokens.output, turn.outputTokens);
    if (turn.usd === null) unpriced.add(turn.promptId);
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
    unpricedTurns: unpriced.size + missing,
    models,
  };
}

/**
 * Several sandboxes' costs as one: an orchestrator's own plus its workers'. The amount sums the priced turns; compute
 * time is known only when every part's is. The basis is "estimated" only when every part is, else "API-equivalent",
 * which is true of any account.
 */
export function combineCosts(costs: readonly SandboxCost[]): SandboxCost {
  const basis: CostBasis =
    costs.length > 0 && costs.every((cost) => cost.basis === "estimated") ? "estimated" : "api_equivalent";
  const tokens: SandboxCost["tokens"] = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  let usd: number | null = null;
  let computeSeconds: number | null = costs.length > 0 ? 0 : null;
  const models: string[] = [];
  for (const cost of costs) {
    tokens.input = add(tokens.input, cost.tokens.input);
    tokens.cached = add(tokens.cached, cost.tokens.cached);
    tokens.cacheWrite = add(tokens.cacheWrite, cost.tokens.cacheWrite);
    tokens.output = add(tokens.output, cost.tokens.output);
    if (cost.usd !== null) usd = (usd ?? 0) + cost.usd;
    computeSeconds =
      computeSeconds === null || cost.computeSeconds === null ? null : computeSeconds + cost.computeSeconds;
    for (const model of cost.models) if (!models.includes(model)) models.push(model);
  }
  return {
    basis,
    label: COST_BASIS_LABELS[basis],
    turns: costs.flatMap((cost) => cost.turns),
    turnCount: costs.reduce((sum, cost) => sum + cost.turnCount, 0),
    computeSeconds,
    tokens,
    usd,
    unpricedTurns: costs.reduce((sum, cost) => sum + cost.unpricedTurns, 0),
    models,
  };
}
