/** USD per million tokens, decimal strings (at most 12 fractional digits). */
export interface TokenRates {
  input: string | null;
  output: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  reasoning: string | null;
}
export function validRate(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/.test(value);
}
export function validRates(rates: TokenRates): boolean {
  return [rates.input, rates.output, rates.cacheRead, rates.cacheWrite, rates.reasoning].every(
    (rate) => rate === null || validRate(rate),
  );
}
