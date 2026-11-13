/** USD per million tokens, decimal strings (at most 12 fractional digits). */
export interface TokenRates {
  input: string | null;
  output: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  reasoning: string | null;
  /** Anthropic first-party 1h cache writes; absent on legacy snapshots. */
  cacheWriteOneHour?: string | null;
}
export function validRate(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/.test(value);
}
export function validRates(rates: TokenRates): boolean {
  return (
    (rates.cacheWriteOneHour === undefined || rates.cacheWriteOneHour === null || validRate(rates.cacheWriteOneHour)) &&
    [rates.input, rates.output, rates.cacheRead, rates.cacheWrite, rates.reasoning].every(
      (rate) => rate === null || validRate(rate),
    )
  );
}
