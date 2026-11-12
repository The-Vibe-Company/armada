import { type TokenRates, validRate } from "./pricing/rates.ts";
import { VaultError } from "./vault-error.ts";

/** Exact native model IDs -> flat USD-per-million rates. Missing cache rates are unknown; output includes reasoning. */
export type ModelPriceOverrides = Record<string, TokenRates>;

export function parseModelPriceOverrides(value: unknown): ModelPriceOverrides {
  const fail = (): never => {
    throw new VaultError(
      "invalid",
      "Invalid model prices: use up to 64 exact model IDs and non-negative decimal strings in USD per million tokens.",
    );
  };
  const object = (row: unknown): row is Record<string, unknown> =>
    row !== null && typeof row === "object" && !Array.isArray(row);
  if (!object(value) || Object.keys(value).length > 64) return fail();
  const optional = (rate: unknown): string | null => {
    if (rate === undefined || rate === null) return null;
    if (!validRate(rate)) return fail();
    return rate;
  };
  return Object.fromEntries(
    Object.entries(value).map(([model, raw]) => {
      if (
        !model ||
        model.length > 256 ||
        /[\s\p{Control}\p{Surrogate}]/u.test(model) ||
        ["__proto__", "constructor", "prototype"].includes(model) ||
        !object(raw)
      )
        return fail();
      if (
        Object.keys(raw).some((key) => !["input", "output", "cacheRead", "cacheWrite", "reasoning"].includes(key)) ||
        !validRate(raw.input) ||
        !validRate(raw.output)
      )
        return fail();
      return [
        model,
        {
          input: raw.input,
          output: raw.output,
          cacheRead: optional(raw.cacheRead),
          cacheWrite: optional(raw.cacheWrite),
          reasoning: optional(raw.reasoning),
        },
      ];
    }),
  );
}
