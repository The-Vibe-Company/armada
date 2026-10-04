// The Insights page's view rules (THE-893, THE-1021 on design/dashboard-v7):
// the last seven days of every project. Every number is computed in core
// (`buildInsights`); this only picks the tiles', the bars' and the table's.
import type { FleetInsights, InsightRange } from "@armada/core/read";

/** The page shows one range: the last seven days. */
export const INSIGHTS_RANGE: InsightRange = "7d";

/** The merges of each day of the range, oldest first. */
export const mergeBars = (i: Pick<FleetInsights, "days">) =>
  i.days.map((d) => ({ day: d.day, count: d.tickets.length }));

/** The time tickets spent blocked over the range, in milliseconds. */
export const blockedMs = (i: Pick<FleetInsights, "phases">) =>
  i.phases.find((p) => p.phase === "blocked")?.totalMs ?? 0;

/** A rate as a whole percent; null when nothing was measured. */
export const percent = (rate: number | null) => (rate === null ? null : Math.round(rate * 100));
