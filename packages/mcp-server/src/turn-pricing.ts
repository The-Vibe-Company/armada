import type {
  CostBasis,
  Harness,
  PricingInputs,
  SandboxUsage,
  SessionCost,
  StoredTurnPricing,
  TurnPriceContext,
  TurnTokenUsage,
} from "@armada/core";
import { type PriceSnapshot, priceTurn, type TokenRates } from "@armada/core/server";
import { validRates } from "../../core/src/pricing/rates.ts";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fields = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const key = (row: Pick<TurnTokenUsage, "promptId" | "model">) => JSON.stringify([row.promptId, row.model]);
type Context = Omit<TurnPriceContext, "promptId" | "model">;

function snapshot(
  value: unknown,
  model: string | null,
  harness: Harness,
  credentialId: string | null,
): PriceSnapshot | null | undefined {
  if (value === null) return null;
  const v = object(value),
    rates = object(v?.rates);
  if (
    !v ||
    !rates ||
    Object.keys(rates).length !== 5 ||
    Object.keys(v).some(
      (k) =>
        !["schemaVersion", "provider", "model", "source", "revision", "connectionId", "rates", "unsupported"].includes(
          k,
        ),
    ) ||
    Object.keys(rates).some((k) => !["input", "output", "cacheRead", "cacheWrite", "reasoning"].includes(k)) ||
    v.schemaVersion !== 1 ||
    v.provider !== (harness === "claude" ? "anthropic" : "openai") ||
    v.model !== model ||
    !text(v.model) ||
    !text(v.revision) ||
    typeof v.unsupported !== "boolean" ||
    !(v.source === "connection" || v.source === "models.dev") ||
    !validRates(rates as unknown as TokenRates) ||
    (v.source === "connection" ? v.connectionId !== credentialId || credentialId === null : v.connectionId !== null)
  )
    return undefined;
  return {
    schemaVersion: 1,
    provider: harness === "claude" ? "anthropic" : "openai",
    model: v.model,
    source: v.source as PriceSnapshot["source"],
    revision: v.revision,
    connectionId: v.connectionId as string | null,
    rates: { ...rates } as unknown as TokenRates,
    unsupported: v.unsupported,
  };
}
function context(value: unknown, row: TurnTokenUsage, harness: Harness, stored: boolean): Context | null {
  const v = object(value);
  const allowed = [
    "schemaVersion",
    "basis",
    "credentialId",
    "credentialVersion",
    "capturedAt",
    "snapshot",
    ...(stored ? ["usd", "unknown", "inputs"] : ["promptId", "model"]),
  ];
  if (
    !v ||
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    v.schemaVersion !== 1 ||
    !(v.basis === "estimated" || v.basis === "api_equivalent") ||
    (v.credentialId !== null && !text(v.credentialId)) ||
    (v.credentialVersion !== null && (!count(v.credentialVersion) || v.credentialVersion < 1)) ||
    (v.credentialId === null) !== (v.credentialVersion === null) ||
    !text(v.capturedAt) ||
    !Number.isFinite(Date.parse(v.capturedAt))
  )
    return null;
  if (!stored && (v.promptId !== row.promptId || v.model !== row.model)) return null;
  const price = snapshot(v.snapshot, row.model, harness, v.credentialId as string | null);
  if (price === undefined || (price !== null && v.credentialId === null)) return null;
  return {
    schemaVersion: 1,
    basis: v.basis as Context["basis"],
    credentialId: v.credentialId as string | null,
    credentialVersion: v.credentialVersion as number | null,
    capturedAt: v.capturedAt,
    snapshot: price,
  };
}
function inputs(row: TurnTokenUsage, harness: Harness): PricingInputs {
  const result = Object.fromEntries(fields.map((k) => [k, count(row[k]) ? row[k] : null])) as unknown as Omit<
    PricingInputs,
    "cacheWriteTtl"
  >;
  let ttl: PricingInputs["cacheWriteTtl"] = null;
  const detail = object("cacheWriteTokensByTtl" in row ? row.cacheWriteTokensByTtl : null);
  if (harness === "claude" && detail) {
    if (detail.conflicted === true || (count(detail.oneHour) && detail.oneHour > 0)) ttl = "other";
    else if (result.cacheWriteTokens !== null && detail.fiveMinute === result.cacheWriteTokens && detail.oneHour === 0)
      ttl = "5m";
  }
  return { ...result, cacheWriteTtl: ttl };
}
function storedInputs(value: unknown): PricingInputs | null {
  const v = object(value);
  if (
    !v ||
    Object.keys(v).some((k) => ![...fields, "cacheWriteTtl"].includes(k as (typeof fields)[number])) ||
    fields.some((k) => v[k] !== null && !count(v[k])) ||
    ![null, "5m", "30m", "other"].includes(v.cacheWriteTtl as PricingInputs["cacheWriteTtl"])
  )
    return null;
  return {
    ...Object.fromEntries(fields.map((k) => [k, v[k]])),
    cacheWriteTtl: v.cacheWriteTtl,
  } as unknown as PricingInputs;
}
const equal = (a: PricingInputs, b: PricingInputs) =>
  fields.every((k) => a[k] === b[k]) && a.cacheWriteTtl === b.cacheWriteTtl;
function complete(input: PricingInputs, price: PriceSnapshot, harness: Harness): boolean {
  const { inputTokens: i, outputTokens: o, cachedTokens: c, cacheWriteTokens: w, reasoningTokens: r } = input;
  return (
    count(i) &&
    count(o) &&
    count(c) &&
    count(w) &&
    (harness !== "codex" || c + w <= i) &&
    (r === null || r <= o) &&
    (price.rates.reasoning === null || count(r)) &&
    (price.source !== "models.dev" || w === 0 || input.cacheWriteTtl === (harness === "claude" ? "5m" : "30m"))
  );
}

/** No current catalog/credential lookup. Only the first admitted context for a share is used. */
export function stampTurnPricing(
  merged: readonly TurnTokenUsage[],
  prior: readonly TurnTokenUsage[],
  observations: readonly TurnTokenUsage[],
  admitted: readonly TurnPriceContext[],
  harness: Harness,
): TurnTokenUsage[] {
  const old = new Map(prior.map((row) => [key(row), row]));
  const observedInputs = new Map<string, Set<string>>();
  for (const row of observations) {
    const identity = key(row);
    let tuples = observedInputs.get(identity);
    if (!tuples) {
      tuples = new Set();
      observedInputs.set(identity, tuples);
    }
    tuples.add(JSON.stringify(inputs(row, harness)));
  }
  const contexts = new Map<string, TurnPriceContext>();
  for (const candidate of admitted) {
    const identity = key(candidate);
    if (contexts.has(identity)) throw new Error("Duplicate turn pricing admission.");
    contexts.set(identity, candidate);
  }
  return merged.map((row) => {
    const before = old.get(key(row));
    const previous = context(before?.pricing, row, harness, true);
    const frozen = previous ?? context(contexts.get(key(row)), row, harness, false);
    if (!frozen) return { ...row, pricing: null };
    const current = inputs(row, harness),
      saved = previous ? object(before?.pricing) : null,
      witness = storedInputs(saved?.inputs);
    // A max-per-field native merge is not necessarily a tuple any harness actually reported.
    const observed =
      (witness && equal(witness, current)) || observedInputs.get(key(row))?.has(JSON.stringify(current)) === true;
    const oldUsd = saved?.usd;
    if (
      witness &&
      equal(witness, current) &&
      frozen.snapshot &&
      !frozen.snapshot.unsupported &&
      complete(witness, frozen.snapshot, harness) &&
      typeof oldUsd === "string" &&
      /^(0|[1-9]\d{0,31})(\.\d{1,18})?$/.test(oldUsd) &&
      saved?.unknown === null
    )
      return { ...row, pricing: { ...frozen, usd: oldUsd, unknown: null, inputs: witness } };
    const priced = observed
      ? priceTurn(
          row,
          harness,
          frozen.snapshot,
          current.cacheWriteTtl === "5m" || current.cacheWriteTtl === "30m" ? current.cacheWriteTtl : null,
        )
      : { usd: null, unknown: "tokens" as const, snapshot: frozen.snapshot };
    const pricing: StoredTurnPricing = { ...frozen, ...priced, inputs: observed ? current : null };
    return { ...row, pricing };
  });
}

/** Select only exact actual-model snapshots from the session's pre-work, immutable admission book. */
export function admittedTurnContexts(
  book: unknown,
  rows: readonly TurnTokenUsage[],
  harness: Harness,
): TurnPriceContext[] {
  const v = object(book),
    prices = object(v?.prices);
  if (
    !v ||
    !prices ||
    v.schemaVersion !== 1 ||
    typeof v.customEndpoint !== "boolean" ||
    v.provider !== (harness === "claude" ? "anthropic" : "openai") ||
    !text(v.catalogRevision)
  )
    return [];
  const selected = new Map<string, TurnPriceContext>();
  for (const row of rows) {
    const price = row.model !== null && Object.hasOwn(prices, row.model) ? prices[row.model] : null;
    const candidate = object(price);
    // Custom endpoints never inherit public rates. A catalog quote must match the admitted revision.
    if (
      candidate &&
      ((v.customEndpoint && candidate.source !== "connection") ||
        (candidate.source === "models.dev" && candidate.revision !== v.catalogRevision))
    )
      continue;
    const input = {
      schemaVersion: 1 as const,
      promptId: row.promptId,
      model: row.model,
      basis: v.basis,
      credentialId: v.credentialId,
      credentialVersion: v.credentialVersion,
      capturedAt: v.capturedAt,
      snapshot: price,
    };
    const valid = context(input, row, harness, false);
    if (valid) selected.set(key(row), { ...valid, promptId: row.promptId, model: row.model });
  }
  return [...selected.values()];
}

/** Server projection of stored quotes only: no catalog, credential lookup or floating-point arithmetic. */
export function withServerCost(usage: SandboxUsage | null, harness: Harness): SandboxUsage | null {
  if (!usage) return null;
  const prompts = new Set(usage.turns.map((row) => row.promptId));
  const coverage =
    count(usage.turnCount) &&
    usage.turnCount === prompts.size &&
    new Set(usage.turns.map(key)).size === usage.turns.length;
  const missing = count(usage.turnCount) && usage.turnCount >= prompts.size ? usage.turnCount - prompts.size : null;
  const unpriced = new Set<string>();
  const bases = new Set<CostBasis>();
  let total = 0n,
    unknown: SessionCost["unknown"] = null;
  for (const row of usage.turns) {
    const valid = context(row.pricing, row, harness, true);
    if (valid) bases.add(valid.basis);
    const saved = object(row.pricing),
      witness = storedInputs(saved?.inputs);
    const usd = saved?.usd;
    if (
      !valid ||
      !witness ||
      !equal(witness, inputs(row, harness)) ||
      !valid.snapshot ||
      valid.snapshot.unsupported ||
      !complete(witness, valid.snapshot, harness) ||
      saved?.unknown !== null ||
      typeof usd !== "string" ||
      !/^(0|[1-9]\d{0,31})(\.\d{1,18})?$/.test(usd)
    ) {
      unpriced.add(row.promptId);
      unknown ??= !valid
        ? "admission"
        : saved?.unknown === "price" || saved?.unknown === "pricing_dimensions"
          ? saved.unknown
          : "tokens";
      continue;
    }
    const [whole, fraction = ""] = usd.split(".");
    total += BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  }
  const fraction = (total % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const usd = `${total / 10n ** 18n}${fraction ? `.${fraction}` : ""}`;
  return {
    ...usage,
    cost: {
      currency: "USD",
      usd: coverage && unknown === null ? usd : null,
      basis:
        usage.turns.every((row) => context(row.pricing, row, harness, true)) && bases.size === 1
          ? [...bases][0]!
          : null,
      unknown: coverage ? unknown : "coverage",
      unpricedTurns: missing === null ? null : unpriced.size + missing,
    },
  };
}
