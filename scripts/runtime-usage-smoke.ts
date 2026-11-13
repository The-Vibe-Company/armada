import type { AgentEvent, SandboxUsage } from "../packages/core/src/index.ts";

const fields = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const measured = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function refuse(): never {
  throw Error("Runtime usage/cost does not match archived harness observations and frozen server admission.");
}
function money(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,31})(\.\d{1,18})?$/.test(value)) return refuse();
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
};
/** Independent deployed-client oracle: no server projection/pricing helpers.
 * Missing dimensions stay unknown; a known subtotal is never called complete. */
export function createRuntimeUsageCheck(credentialId: string) {
  const observations = new Map<string, Record<string, unknown>>();
  const admissions = new Map<string, string>();
  return {
    has(promptId: string) {
      return observations.has(promptId);
    },
    observe(event: AgentEvent) {
      if (event.promptId && event.kind === "other" && event.type === "armada/turnUsage" && object(event.data))
        observations.set(event.promptId, event.data);
    },
    verify(usage: SandboxUsage | undefined) {
      if (
        !usage ||
        !observations.size ||
        usage.turnCount !== observations.size ||
        usage.turns.length !== observations.size
      )
        return refuse();
      let total = 0n,
        unpriced = 0,
        incomplete = false;
      const bases = new Set<string>();
      for (const [promptId, raw] of observations) {
        if (
          typeof raw.model !== "string" ||
          !raw.model ||
          !measured(raw.inputTokens) ||
          !measured(raw.outputTokens) ||
          raw.inputTokens + raw.outputTokens === 0 ||
          !measured(raw.cachedTokens)
        )
          return refuse();
        const rows = usage.turns.filter((r) => r.promptId === promptId && r.model === raw.model);
        const row = rows[0],
          quote = row?.pricing;
        if (
          rows.length !== 1 ||
          !row ||
          !quote ||
          quote.schemaVersion !== 1 ||
          quote.credentialId?.toLowerCase() !== credentialId.toLowerCase() ||
          !measured(quote.credentialVersion) ||
          quote.credentialVersion < 1 ||
          !["estimated", "api_equivalent"].includes(quote.basis) ||
          !Number.isFinite(Date.parse(quote.capturedAt)) ||
          !quote.inputs
        )
          return refuse();
        for (const field of fields) {
          const actual = measured(raw[field]) ? raw[field] : null;
          if ((row[field] ?? null) !== actual || quote.inputs[field] !== actual) return refuse();
        }
        if (
          quote.snapshot &&
          (quote.snapshot.model !== raw.model || !["connection", "models.dev"].includes(quote.snapshot.source))
        )
          return refuse();
        const admitted = canonical({
          basis: quote.basis,
          credentialId: quote.credentialId,
          credentialVersion: quote.credentialVersion,
          capturedAt: quote.capturedAt,
          snapshot: quote.snapshot,
        });
        const previous = admissions.get(raw.model);
        if (previous !== undefined && previous !== admitted) return refuse();
        admissions.set(raw.model, admitted);
        bases.add(quote.basis);
        if (quote.usd === null) {
          if (!["tokens", "price", "pricing_dimensions"].includes(quote.unknown ?? "")) return refuse();
          unpriced++;
        } else {
          if (!quote.snapshot || quote.unknown !== null) return refuse();
          total += money(quote.usd);
        }
      }
      for (const field of fields) {
        const values = [...observations.values()].map((r) => r[field]).filter(measured);
        const sum = values.reduce((a, b) => a + b, 0);
        if (!Number.isSafeInteger(sum) || usage.tokenTotals?.[field] !== (values.length ? sum : null)) return refuse();
        if (values.length !== observations.size) incomplete = true;
      }
      if (incomplete && usage.tokenTotals?.incomplete !== true) return refuse();
      const cost = usage.cost;
      if (
        !cost ||
        cost.currency !== "USD" ||
        bases.size !== 1 ||
        !cost.basis ||
        !bases.has(cost.basis) ||
        cost.unpricedTurns !== unpriced
      )
        return refuse();
      if (
        unpriced
          ? cost.usd !== null || !["tokens", "price", "pricing_dimensions"].includes(cost.unknown ?? "")
          : cost.unknown !== null || money(cost.usd) !== total
      )
        return refuse();
      return {
        turnCount: usage.turnCount,
        tokenTotals: usage.tokenTotals,
        admission: "frozen",
        cost: { status: unpriced ? "unknown" : "priced", usd: cost.usd, basis: cost.basis, unknown: cost.unknown },
      };
    },
  };
}
