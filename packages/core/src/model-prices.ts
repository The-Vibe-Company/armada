/**
 * Published per-token list prices for the models Armada launches, in USD per million tokens, so a client can turn the
 * token counts of a sandbox's turns into an estimated cost. The server holds no prices: this table is versioned with
 * the code and read only by clients (the dashboard).
 *
 * Sources, read on MODEL_PRICES_AS_OF:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing": base input, 5-minute cache
 *   write, cache hits, output). Claude 4.6 and later bill the full 1M context window at these rates.
 * - OpenAI: https://developers.openai.com/api/docs/pricing (Standard tier, prompts up to 272K tokens: input, cached
 *   input, 30-minute cache write, output).
 *
 * A model missing here has no price: the cost of its turns is "price unknown", never zero. A turn's totals do not say
 * how long each request's prompt was, so the short-prompt rate is applied: Claude Haiku 5.5 above 100,000 prompt
 * tokens and OpenAI above 272K input tokens cost more, and their figures are then a lower bound. Batch, priority,
 * fast-mode and data-residency rates are not applied.
 */
export const MODEL_PRICES_AS_OF = "2026-11-10";

export const MODEL_PRICE_SOURCES = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
} as const;

export type PriceVendor = keyof typeof MODEL_PRICE_SOURCES;

export interface ModelPrice {
  vendor: PriceVendor;
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million input tokens read from the prompt cache. */
  cacheRead: number;
  /** USD per million tokens written to the prompt cache (Anthropic's 5-minute write, OpenAI's 30-minute write). */
  cacheWrite: number;
}

const anthropic = (input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrice => ({
  vendor: "anthropic",
  input,
  output,
  cacheRead,
  cacheWrite,
});
const openai = (input: number, cacheRead: number, cacheWrite: number, output: number): ModelPrice => ({
  vendor: "openai",
  input,
  output,
  cacheRead,
  cacheWrite,
});

/** Keyed by the id the harness reports. Arguments in the order of each source's table. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic: input, 5m cache write, cache hit, output.
  "claude-fable-5-2": anthropic(8, 10, 0.2, 40),
  "claude-fable-5-1": anthropic(10, 12.5, 0.25, 50),
  "claude-fable-5": anthropic(10, 12.5, 1, 50),
  "claude-opus-5-5": anthropic(4, 5, 0.2, 20),
  "claude-opus-5": anthropic(5, 6.25, 0.5, 25),
  "claude-sonnet-5-5": anthropic(2, 2.5, 0.1, 10),
  "claude-sonnet-5": anthropic(2, 2.5, 0.2, 10),
  // Prompts up to 100,000 tokens: Claude Code's background calls are short.
  "claude-haiku-5-5": anthropic(0.1, 0.125, 0.01, 0.5),
  // OpenAI: input, cached input, 30m cache write, output.
  "gpt-6-astra": openai(10, 1, 12.5, 50),
  "gpt-6.1-sol": openai(2, 0.1, 2.5, 10),
  "gpt-6.1-terra": openai(1, 0.05, 1.25, 5),
  "gpt-6-sol": openai(2, 0.2, 2.5, 10),
  "gpt-6-luna": openai(0.1, 0.01, 0.125, 0.5),
};

/**
 * The price of a reported model id, or null when it has none. Claude Code may report a context-window suffix
 * (`claude-opus-5-5[1m]`, same rate) or a dated snapshot (`claude-sonnet-5-5-20261001`); both resolve to the model.
 */
export function modelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
  return Object.hasOwn(MODEL_PRICES, id) ? (MODEL_PRICES[id] ?? null) : null;
}
