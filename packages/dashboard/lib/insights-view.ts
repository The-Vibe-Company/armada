// The Insights page's view rules (THE-893): its address (range, project, the
// number opened), the tickets behind each number, and where a ticket links.
// Every number is computed in core (`buildInsights`); this only picks.
import {
  type FleetInsights,
  INSIGHT_RANGES,
  type InsightRange,
  type InsightsSummary,
  type InsightTicket,
  isInsightRange,
  LABEL_PHASES,
  type LabelPhase,
} from "@armada/core/read";
import type { InsightsReading } from "./fleet-data";
import { paths } from "./fleet-view";

/** How a ticket is keyed in the reading's facts: tickets of two projects may share an id. */
export const insightKey = (project: string, ticket: string) => `${project}/${ticket}`;

export const DEFAULT_RANGE: InsightRange = "30d";

/** What the page's address says: `?range=7d|30d|90d&project=<slug>&show=<number>`. */
export interface InsightsQuery {
  range: InsightRange;
  project: string | null;
  show: string | null;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export function insightsQuery(params: Record<string, string | string[] | undefined>): InsightsQuery {
  const range = one(params.range);
  const project = one(params.project);
  return {
    range: isInsightRange(range) ? range : DEFAULT_RANGE,
    project: project && /^[a-z0-9][a-z0-9-]{0,63}$/.test(project) ? project : null,
    show: one(params.show),
  };
}

/** The page's address for `q`; the default range is left out. */
export function insightsHref(q: Partial<InsightsQuery>): string {
  const p = new URLSearchParams();
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.project) p.set("project", q.project);
  if (q.show) p.set("show", q.show);
  const s = p.toString();
  return s ? `${paths.insights}?${s}` : paths.insights;
}

export { INSIGHT_RANGES };

/** What a `show` names: one of the page's numbers, and its own part (a day, a phase, a profile). */
export type Behind =
  | { kind: "merged" | "cycle" | "first-pass" | "redone" | "silences" }
  | { kind: "day" | "week"; day: string }
  | { kind: "phase"; phase: LabelPhase }
  | { kind: "waits"; who: "coordinator" | "owner" }
  | { kind: "profile" | "harness"; key: string };

export function behindOf(show: string | null): Behind | null {
  if (!show) return null;
  const [kind, arg = ""] = show.split(":", 2) as [string, string | undefined];
  switch (kind) {
    case "merged":
    case "cycle":
    case "first-pass":
    case "redone":
    case "silences":
      return arg ? null : { kind };
    case "day":
    case "week":
      return /^\d{4}-\d{2}-\d{2}$/.test(arg) ? { kind, day: arg } : null;
    case "phase": {
      const phase = LABEL_PHASES.find((p) => p === arg);
      return phase ? { kind, phase } : null;
    }
    case "waits":
      return arg === "coordinator" || arg === "owner" ? { kind, who: arg } : null;
    case "profile":
    case "harness":
      return arg ? { kind, key: arg } : null;
    default:
      return null;
  }
}

/** The `show` value that opens `b`. */
export function showOf(b: Behind): string {
  switch (b.kind) {
    case "day":
    case "week":
      return `${b.kind}:${b.day}`;
    case "phase":
      return `phase:${b.phase}`;
    case "waits":
      return `waits:${b.who}`;
    case "profile":
    case "harness":
      return `${b.kind}:${b.key}`;
    default:
      return b.kind;
  }
}

/** The tickets behind a number, as core gave them. */
export function ticketsBehind(i: FleetInsights, b: Behind): InsightTicket[] {
  switch (b.kind) {
    case "merged":
      return i.merged.tickets;
    case "day":
      return i.days.find((d) => d.day === b.day)?.tickets ?? [];
    case "week":
      return i.weeks.find((w) => w.week === b.day)?.tickets ?? [];
    case "cycle":
      return i.cycle.tickets;
    case "phase":
      return i.phases.find((p) => p.phase === b.phase)?.tickets ?? [];
    case "waits":
      return i.waits[b.who].tickets;
    case "first-pass":
      return i.firstPass.tickets;
    case "redone":
      return i.firstPass.redone;
    case "silences":
      return i.silences.tickets;
    case "profile":
      return i.profiles.find((p) => p.key === b.key)?.tickets ?? [];
    case "harness":
      return i.harnesses.find((h) => h.key === b.key)?.tickets ?? [];
  }
}

/** Where a ticket opens: its agent's page while a worker holds it, else its Linear issue; null when neither is known. */
export function ticketHref(r: InsightsReading, project: string, ticket: string): string | null {
  const facts = r.tickets[insightKey(project, ticket)];
  if (facts?.inFlight) return paths.agent(ticket);
  return facts?.url ?? null;
}

/**
 * The bars of the shipped chart: one per day up to 30 days, one per ISO week
 * beyond (90 bars would be a texture, not a chart).
 */
/** The ISO week (its Monday) a UTC day falls in. */
const mondayOf = (day: string): string => {
  const t = Date.parse(`${day}T00:00:00Z`);
  const back = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
};

/**
 * The shipped chart's bars, with `previous`: the merges of the period
 * before at the same place (the ghost bars, THE-899), its days a period
 * earlier summed into the same weeks.
 */
export function shippedBars(
  i: FleetInsights,
): { key: string; kind: "day" | "week"; count: number; previous: number }[] {
  const before = (k: number) => i.merged.previousDaily?.[k] ?? 0;
  if (i.days.length <= 31)
    return i.days.map((d, k) => ({ key: d.day, kind: "day", count: d.tickets.length, previous: before(k) }));
  const previous = new Map<string, number>();
  i.days.forEach((d, k) => {
    const week = mondayOf(d.day);
    previous.set(week, (previous.get(week) ?? 0) + before(k));
  });
  return i.weeks.map((w) => ({
    key: w.week,
    kind: "week",
    count: w.tickets.length,
    previous: previous.get(w.week) ?? 0,
  }));
}

/** The overview's insights line as its page reads it (THE-892): what `/api/fleet/insights?range=7d` answers, and its tag. */
export interface InsightsLineReading {
  body: { range: "7d"; project: null; live: boolean; summary: InsightsSummary };
  tag: string;
}
