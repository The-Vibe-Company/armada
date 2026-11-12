/** Explicit maintenance command; never used at server startup. Review the emitted diff before shipping. */
import { createHash } from "node:crypto";
import { type TokenRates, validRate } from "../packages/core/src/pricing/rates.ts";

const source = "https://models.dev/api.json";
const response = await fetch(source);
if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
const raw = await response.text();
const data = JSON.parse(raw);
const models: Record<string, { rates: TokenRates; unsupported: boolean }> = {};
const rate = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !validRate(String(value)))
    throw new Error("Invalid models.dev rate");
  return String(value);
};
for (const provider of ["anthropic", "openai"]) {
  const entry = data[provider];
  if (entry?.id !== provider || typeof entry.models !== "object" || !entry.models)
    throw new Error(`Invalid provider: ${provider}`);
  for (const id of Object.keys(entry.models).sort()) {
    const model = entry.models[id];
    if (model.id !== id) throw new Error("Mismatched model ID");
    if (!model.cost) continue;
    const cost = model.cost;
    const input = rate(cost.input),
      output = rate(cost.output);
    if (input === null || output === null) throw new Error("Missing base rates");
    models[`${provider}/${id}`] = {
      rates: {
        input,
        output,
        cacheRead: rate(cost.cache_read),
        cacheWrite: rate(cost.cache_write),
        reasoning: rate(cost.reasoning),
      },
      // Aggregate turns cannot select request-level tiers or account for audio/tool charges.
      unsupported:
        (model.type !== undefined && model.type !== "text") ||
        !Array.isArray(model.modalities?.output) ||
        model.modalities.output.length !== 1 ||
        model.modalities.output[0] !== "text" ||
        Object.keys(cost).some((key) => !["input", "output", "cache_read", "cache_write", "reasoning"].includes(key)),
    };
  }
}
await Bun.write(
  new URL("../packages/core/src/pricing/models-dev.json", import.meta.url),
  `${JSON.stringify(
    {
      source,
      fetchedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(raw).digest("hex"),
      license: "MIT",
      units: "USD per million tokens",
      models,
    },
    null,
    2,
  )}\n`,
);
