/** Public allowlisted quota exhaustion evidence; never a vendor response body. */
export interface PlanLimit {
  code: "usage_limit_exceeded" | "rate_limited";
  resetsAt?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function reset(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : undefined;
}
export function planLimitData(value: unknown): PlanLimit | undefined {
  if (!record(value) || (value.code !== "usage_limit_exceeded" && value.code !== "rate_limited")) return undefined;
  const resetsAt = reset(value.resetsAt);
  return { code: value.code, ...(resetsAt ? { resetsAt } : {}) };
}
export function planLimitMessage(limit: PlanLimit): string {
  return `${limit.code === "rate_limited" ? "Rate limit reached." : "Plan limit reached."}${limit.resetsAt ? ` Resets at ${limit.resetsAt}.` : " Try again after the limit resets."}`;
}
/** Only our fixed bridge diagnosis can acquire structured public fields from a string. */
export function planLimitFromMessage(value: string | undefined): PlanLimit | undefined {
  const match =
    /^(Plan|Rate) limit reached\. (?:Resets at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z)\.|Try again after the limit resets\.)$/.exec(
      value ?? "",
    );
  if (!match || (match[2] && !reset(match[2]))) return undefined;
  return {
    code: match[1] === "Plan" ? "usage_limit_exceeded" : "rate_limited",
    ...(match[2] ? { resetsAt: match[2] } : {}),
  };
}
/** Every exhausted window must reset before work can resume. Unused windows do not predict recovery. */
export function codexPlanLimit(snapshot: unknown, code: PlanLimit["code"]): PlanLimit {
  const windows = record(snapshot) ? [snapshot.primary, snapshot.secondary] : [];
  const values = windows.flatMap((window) =>
    record(window) &&
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 100 &&
    window.usedPercent <= Number.MAX_SAFE_INTEGER &&
    typeof window.resetsAt === "number" &&
    Number.isSafeInteger(window.resetsAt) &&
    window.resetsAt >= 0 &&
    window.resetsAt <= 253402300799
      ? [window.resetsAt]
      : [],
  );
  return { code, ...(values.length ? { resetsAt: new Date(Math.max(...values) * 1000).toISOString() } : {}) };
}
