import type { ProjectUsage } from "./usage.js";

export { projectUsageSchema } from "./usage.js";

/** Civil date and minute at an instant. Intl handles IANA offsets and daylight-saving changes. */
export function usageTime(at: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${value("year")}-${value("month")}-${value("day")}`, minute: `${value("hour")}:${value("minute")}` };
}
export const formatTokens = (value: number | null): string =>
  value === null
    ? "unknown"
    : value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
        : `${value}`;
export function todayUsage(usage: ProjectUsage, at: string) {
  return usage.days.find((d) => d.day === usageTime(at, usage.zone).day);
}
export function usageSummary(usage: ProjectUsage, at: string) {
  const day = todayUsage(usage, at);
  if (!day) return "today: usage unknown, workers 0 launched, 0 reported usage";
  const c = day.coordinator;
  return `today: coordinator ${formatTokens(c.input)} in / ${formatTokens(c.output)} out, cache ${formatTokens(c.cacheRead)} read / ${formatTokens(c.cacheWrite)} write${c.models.length ? ` (${c.models.join(", ")})` : ""}${c.unknown ? `, ${c.unknown} unknown` : ""}, workers ${day.workerLaunches} launched, ${day.workersReported} reported usage`;
}
