// How fast the fleet ships and where tickets wait (THE-893): the Insights
// page's numbers, computed from what Armada already records (claims, reports
// with their phase and head, heartbeats, releases, merges, the coordinator's
// inbox, the owner's validations and the sessions that held each ticket).
// Pure: the dashboard reads the records from Postgres (`insightRecords`) and
// hands them here; nothing is written. Every number carries the tickets
// behind it, so the page can link each one to them.
import { NEEDS_HUMAN } from "./fleet.ts";
import { type AgentPhase, LABEL_PHASES, type LabelPhase } from "./types.ts";
import type { ValidationKind, ValidationOutcome } from "./validations.ts";

export const INSIGHT_RANGES = ["7d", "30d", "90d"] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];
export const RANGE_DAYS: Record<InsightRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const isInsightRange = (v: unknown): v is InsightRange => (INSIGHT_RANGES as readonly unknown[]).includes(v);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ records

/** One of a ticket's events, as `insightRecords` reads it. */
export interface InsightEvent {
  ticket: string;
  kind: "claim" | "report" | "heartbeat" | "release" | "merge";
  phase: string | null;
  headSha: string | null;
  at: string;
  /**
   * The ticket's event before this one, when it came longer than the
   * silence threshold before: the start of a gap. Heartbeats are read only
   * when they end one, or are the ticket's last event (`last`).
   */
  gapFrom: string | null;
  /** The ticket's newest event of all: an ongoing silence counts from it. */
  last: boolean;
}

/** A session that held a ticket (`fleet_sessions`). */
export interface InsightSession {
  ticket: string;
  runtime: string;
  profile: string | null;
  claimedAt: string;
  releasedAt: string | null;
}

/** Something the coordinator had to answer: a question, a plan, a hand-back. */
export interface InsightWait {
  ticket: string | null;
  kind: "question" | "plan" | "hand-back";
  createdAt: string;
  resolvedAt: string | null;
}

/** Something the owner had to decide (THE-885). */
export interface InsightValidation {
  ticket: string;
  kind: ValidationKind;
  createdAt: string;
  decidedAt: string | null;
  outcome: ValidationOutcome | null;
}

/** One project's records since twice the range back (the previous period gives the trend). */
export interface ProjectInsightRecords {
  project: string;
  /** `policy.silence_minutes` of the project. */
  silentAfterMinutes: number;
  events: InsightEvent[];
  sessions: InsightSession[];
  waits: InsightWait[];
  validations: InsightValidation[];
}

// ------------------------------------------------------------------ what the page shows

/** A ticket behind a number, with its own value (a duration in ms, a count) when it has one. */
export interface InsightTicket {
  project: string;
  ticket: string;
  value: number | null;
  at: string;
}

export interface DurationStat {
  count: number;
  p50: number | null;
  p90: number | null;
}

export interface WaitStat extends DurationStat {
  /** Waits still open now. */
  open: number;
  tickets: InsightTicket[];
}

export interface InsightComparison {
  /** A profile's name ("none" when the claim named none), or a harness. */
  key: string;
  merged: number;
  cycleP50: number | null;
  /** Plans sent again for approval, per merged ticket. */
  replans: number;
  /** New heads after a hand-back, per merged ticket. */
  newHeads: number;
  silences: number;
  workerHours: number;
  silencesPerWorkerHour: number | null;
  tickets: InsightTicket[];
}

export interface PhaseTime {
  phase: LabelPhase;
  totalMs: number;
  /** Over the merged tickets that went through the phase. */
  medianMs: number | null;
  tickets: InsightTicket[];
}

export interface BiggestWait {
  project: string;
  ticket: string;
  phase: LabelPhase;
  from: string;
  /** Null while it goes on. */
  to: string | null;
  ms: number;
}

export interface FleetInsights {
  range: InsightRange;
  /** The first UTC day of the range, its start. */
  from: string;
  to: string;
  previousFrom: string;
  days: { day: string; tickets: InsightTicket[] }[];
  /** ISO weeks (their Monday) the range touches. */
  weeks: { week: string; tickets: InsightTicket[] }[];
  merged: { count: number; previous: number; tickets: InsightTicket[] };
  cycle: DurationStat & { previousP50: number | null; tickets: InsightTicket[]; daily: (number | null)[] };
  phases: PhaseTime[];
  waits: { coordinator: WaitStat; owner: WaitStat };
  firstPass: {
    green: number;
    handedBack: number;
    rate: number | null;
    tickets: InsightTicket[];
    redone: InsightTicket[];
  };
  silences: {
    count: number;
    workerHours: number;
    perWorkerHour: number | null;
    tickets: InsightTicket[];
  };
  profiles: InsightComparison[];
  harnesses: InsightComparison[];
  biggestWaits: BiggestWait[];
}

// ------------------------------------------------------------------ helpers

/** The nearest-rank quantile: always one of the values. */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

const stat = (values: readonly number[]): DurationStat => ({
  count: values.length,
  p50: quantile(values, 0.5),
  p90: quantile(values, 0.9),
});

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;
/** The Monday of the ISO week of `ms`, as YYYY-MM-DD. */
const weekOf = (ms: number) => {
  const day = startOfDay(ms);
  return dayOf(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY);
};
const iso = (ms: number) => new Date(ms).toISOString();
/** ISO times and keys compare as plain strings: `localeCompare` is far slower on tens of thousands. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The harness a worker runs on, from its claim's runtime (`Conductor`, `claude-code`…). */
export function runtimeHarness(runtime: string | null | undefined): "conductor" | "claude-code" | "codex" | "other" {
  const r = (runtime ?? "").toLowerCase();
  if (r.includes("conductor")) return "conductor";
  if (r.includes("claude")) return "claude-code";
  if (r.includes("codex")) return "codex";
  return "other";
}

/** The phases a ticket waits on someone else in: they never count as a silence. */
const waiting = (phase: AgentPhase | null) => phase !== null && NEEDS_HUMAN.includes(phase);
const asPhase = (p: string | null): LabelPhase | null => LABEL_PHASES.find((x) => x === p) ?? null;

interface Stretch {
  /** Null while no worker held the ticket (after a release or a merge). */
  phase: LabelPhase | null;
  from: number;
  /** The next event; null for the last stretch. */
  to: number | null;
}

/** A ticket's phases from its claims, reports, releases and merges, oldest first. */
function stretchesOf(events: readonly InsightEvent[]): Stretch[] {
  const out: Stretch[] = [];
  for (const e of events) {
    if (e.kind === "heartbeat") continue;
    const at = Date.parse(e.at);
    const held = out.at(-1)?.phase ?? null;
    const phase =
      e.kind === "release" || e.kind === "merge"
        ? null
        : e.kind === "claim"
          ? (asPhase(e.phase) ?? "planning")
          : (asPhase(e.phase) ?? held);
    const last = out.at(-1);
    if (last && last.phase === phase) continue;
    if (last) last.to = at;
    out.push({ phase, from: at, to: null });
  }
  return out;
}

const phaseAt = (stretches: readonly Stretch[], t: number): LabelPhase | null =>
  stretches.findLast((s) => s.from <= t)?.phase ?? null;

/** One ticket's way from its first claim to its merge. */
interface Cycle {
  project: string;
  ticket: string;
  claimedAt: number;
  mergedAt: number;
  phases: Partial<Record<LabelPhase, number>>;
  replans: number;
  heads: number;
  profile: string;
  harness: string;
}

const sessionAt = (sessions: readonly InsightSession[], t: number) =>
  sessions.findLast((s) => Date.parse(s.claimedAt) <= t) ?? sessions[0] ?? null;

/** Every claim-to-merge of a ticket: from its first claim since its previous merge. */
function cyclesOf(project: string, ticket: string, events: InsightEvent[], sessions: InsightSession[]): Cycle[] {
  const cycles: Cycle[] = [];
  let start = -1;
  for (let k = 0; k < events.length; k++) {
    const e = events[k] as InsightEvent;
    if (e.kind === "claim" && start < 0) start = k;
    if (e.kind !== "merge") continue;
    if (start >= 0) {
      const run = events.slice(start, k + 1);
      const mergedAt = Date.parse(e.at);
      const phases: Cycle["phases"] = {};
      for (const s of stretchesOf(run))
        if (s.phase && s.to !== null) phases[s.phase] = (phases[s.phase] ?? 0) + (s.to - s.from);
      let approvals = 0;
      let previous: string | null = null;
      for (const r of run) {
        if (r.kind !== "report" && r.kind !== "claim") continue;
        if (r.phase === "awaiting-approval" && previous !== "awaiting-approval") approvals++;
        previous = r.phase ?? previous;
      }
      const heads = new Set(
        run.filter((r) => r.kind === "report" && r.phase === "ready-to-merge" && r.headSha).map((r) => r.headSha),
      );
      const session = sessionAt(sessions, mergedAt);
      cycles.push({
        project,
        ticket,
        claimedAt: Date.parse((events[start] as InsightEvent).at),
        mergedAt,
        phases,
        replans: Math.max(0, approvals - 1),
        heads: heads.size,
        profile: session?.profile ?? "none",
        harness: runtimeHarness(session?.runtime),
      });
    }
    start = -1;
  }
  return cycles;
}

interface Silence {
  project: string;
  ticket: string;
  from: number;
  to: number;
  profile: string;
  harness: string;
}

/**
 * A ticket's silences: gaps longer than the threshold between its events
 * while a worker held it in a phase that waits on no one (the live
 * timeline's rule), and the one going on now while a session still holds it.
 */
function silencesOf(
  r: ProjectInsightRecords,
  ticket: string,
  events: InsightEvent[],
  sessions: InsightSession[],
  now: number,
): Silence[] {
  const stretches = stretchesOf(events);
  const threshold = r.silentAfterMinutes * MIN;
  const quiet = (t: number) => {
    const phase = phaseAt(stretches, t);
    return phase !== null && !waiting(phase);
  };
  const of = (from: number, to: number): Silence => {
    const s = sessionAt(sessions, from);
    return {
      project: r.project,
      ticket,
      from,
      to,
      profile: s?.profile ?? "none",
      harness: runtimeHarness(s?.runtime),
    };
  };
  const out: Silence[] = [];
  for (const e of events) {
    if (!e.gapFrom) continue;
    const from = Date.parse(e.gapFrom);
    const to = Date.parse(e.at);
    if (to - from > threshold && quiet(from)) out.push(of(from, to));
  }
  const last = events.findLast((e) => e.last);
  const open = sessions.some((s) => s.releasedAt === null);
  if (last && open && now - Date.parse(last.at) > threshold && quiet(Date.parse(last.at)))
    out.push(of(Date.parse(last.at), now));
  return out;
}

const ticketOf = (project: string, ticket: string, value: number | null, at: number): InsightTicket => ({
  project,
  ticket,
  value,
  at: iso(at),
});

const byValue = (a: InsightTicket, b: InsightTicket) => (b.value ?? 0) - (a.value ?? 0) || order(a.at, b.at);

/** Records by ticket, in their order. */
function groupBy<T extends { ticket: string }>(records: readonly T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const r of records) {
    const list = by.get(r.ticket);
    if (list) list.push(r);
    else by.set(r.ticket, [r]);
  }
  return by;
}

const overlap = (from: number, to: number, start: number, end: number) =>
  Math.max(0, Math.min(to, end) - Math.max(from, start));

// ------------------------------------------------------------------ the numbers

/** How many of the biggest waits the page ranks. */
export const BIGGEST_WAITS = 10;

export function buildInsights(input: {
  records: readonly ProjectInsightRecords[];
  range: InsightRange;
  now: Date;
}): FleetInsights {
  const now = input.now.getTime();
  const days = RANGE_DAYS[input.range];
  const from = startOfDay(now) - (days - 1) * DAY;
  const previousFrom = from - days * DAY;
  const inRange = (t: number) => t >= from && t <= now;

  const cycles: Cycle[] = [];
  const silences: Silence[] = [];
  const merges: InsightTicket[] = [];
  let previousMerged = 0;
  const hours = new Map<string, number>();
  const addHours = (key: string, h: number) => hours.set(key, (hours.get(key) ?? 0) + h);
  const biggest: BiggestWait[] = [];
  const coordinatorWaits: number[] = [];
  const coordinatorTickets: InsightTicket[] = [];
  let coordinatorOpen = 0;
  const ownerWaits: number[] = [];
  const ownerTickets: InsightTicket[] = [];
  let ownerOpen = 0;

  for (const r of input.records) {
    const events = groupBy(r.events);
    const sessions = groupBy(r.sessions);
    for (const list of events.values()) list.sort((a, b) => order(a.at, b.at));
    for (const list of sessions.values()) list.sort((a, b) => order(a.claimedAt, b.claimedAt));

    for (const [ticket, list] of events) {
      const held = sessions.get(ticket) ?? [];
      for (const e of list) {
        if (e.kind !== "merge") continue;
        const at = Date.parse(e.at);
        if (inRange(at)) merges.push(ticketOf(r.project, ticket, null, at));
        else if (at >= previousFrom && at < from) previousMerged++;
      }
      cycles.push(...cyclesOf(r.project, ticket, list, held));
      silences.push(...silencesOf(r, ticket, list, held, now).filter((s) => inRange(s.to)));
      // Where tickets wait: each stretch in a phase that waits on someone, clipped to the range.
      const open = held.some((s) => s.releasedAt === null);
      for (const s of stretchesOf(list)) {
        if (!s.phase || !waiting(s.phase)) continue;
        if (s.to === null && !open) continue;
        const end = s.to ?? now;
        const ms = overlap(s.from, end, from, now);
        if (ms > 0)
          biggest.push({
            project: r.project,
            ticket,
            phase: s.phase,
            from: iso(s.from),
            to: s.to ? iso(s.to) : null,
            ms,
          });
      }
    }

    for (const s of r.sessions) {
      const h = overlap(Date.parse(s.claimedAt), s.releasedAt ? Date.parse(s.releasedAt) : now, from, now) / HOUR;
      addHours("all", h);
      addHours(`profile:${s.profile ?? "none"}`, h);
      addHours(`harness:${runtimeHarness(s.runtime)}`, h);
    }

    for (const w of r.waits) {
      const created = Date.parse(w.createdAt);
      if (!inRange(created) || !w.ticket) continue;
      if (w.resolvedAt === null) {
        coordinatorOpen++;
        coordinatorTickets.push(ticketOf(r.project, w.ticket, now - created, created));
        continue;
      }
      const ms = Date.parse(w.resolvedAt) - created;
      coordinatorWaits.push(ms);
      coordinatorTickets.push(ticketOf(r.project, w.ticket, ms, created));
    }
    for (const v of r.validations) {
      const created = Date.parse(v.createdAt);
      if (!inRange(created) || v.outcome === "superseded") continue;
      if (v.decidedAt === null) {
        ownerOpen++;
        ownerTickets.push(ticketOf(r.project, v.ticket, now - created, created));
        continue;
      }
      const ms = Date.parse(v.decidedAt) - created;
      ownerWaits.push(ms);
      ownerTickets.push(ticketOf(r.project, v.ticket, ms, created));
    }
  }

  const current = cycles.filter((c) => inRange(c.mergedAt));
  const previous = cycles.filter((c) => c.mergedAt >= previousFrom && c.mergedAt < from);
  const cycleMs = (c: Cycle) => c.mergedAt - c.claimedAt;
  const cycleTickets = current.map((c) => ticketOf(c.project, c.ticket, cycleMs(c), c.mergedAt)).sort(byValue);

  const byDay = new Map<string, number[]>();
  for (const c of current) {
    const day = dayOf(c.mergedAt);
    const list = byDay.get(day);
    if (list) list.push(cycleMs(c));
    else byDay.set(day, [cycleMs(c)]);
  }
  const dayList = Array.from({ length: days }, (_, k) => dayOf(from + k * DAY));
  const dayTickets = (day: string) => merges.filter((m) => m.at.slice(0, 10) === day);
  const weekOfDay = new Map(dayList.map((d) => [d, weekOf(Date.parse(d))]));
  const weekList = [...new Set(weekOfDay.values())];

  const phases: PhaseTime[] = LABEL_PHASES.map((phase) => {
    const went = current.filter((c) => (c.phases[phase] ?? 0) > 0);
    const values = went.map((c) => c.phases[phase] ?? 0);
    return {
      phase,
      totalMs: values.reduce((a, b) => a + b, 0),
      medianMs: quantile(values, 0.5),
      tickets: went.map((c) => ticketOf(c.project, c.ticket, c.phases[phase] ?? 0, c.mergedAt)).sort(byValue),
    };
  });

  const handedBack = current.filter((c) => c.heads > 0);
  const green = handedBack.filter((c) => c.heads === 1);
  const workerHours = hours.get("all") ?? 0;
  const perHour = (count: number, h: number) => (h > 0 ? count / h : null);

  const compare = (kind: "profile" | "harness"): InsightComparison[] => {
    const keys = new Set([
      ...current.map((c) => c[kind]),
      ...silences.map((s) => s[kind]),
      ...[...hours.keys()].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)),
    ]);
    return [...keys]
      .map((key) => {
        const mine = current.filter((c) => c[kind] === key);
        const quiet = silences.filter((s) => s[kind] === key).length;
        const h = hours.get(`${kind}:${key}`) ?? 0;
        return {
          key,
          merged: mine.length,
          cycleP50: quantile(mine.map(cycleMs), 0.5),
          replans: mine.length ? mine.reduce((n, c) => n + c.replans, 0) / mine.length : 0,
          newHeads: mine.length ? mine.reduce((n, c) => n + Math.max(0, c.heads - 1), 0) / mine.length : 0,
          silences: quiet,
          workerHours: h,
          silencesPerWorkerHour: perHour(quiet, h),
          tickets: mine.map((c) => ticketOf(c.project, c.ticket, cycleMs(c), c.mergedAt)).sort(byValue),
        };
      })
      .filter((c) => c.merged > 0 || c.workerHours > 0)
      .sort((a, b) => b.merged - a.merged || b.workerHours - a.workerHours || order(a.key, b.key));
  };

  return {
    range: input.range,
    from: iso(from),
    to: iso(now),
    previousFrom: iso(previousFrom),
    days: dayList.map((day) => ({ day, tickets: dayTickets(day) })),
    weeks: weekList.map((week) => ({ week, tickets: merges.filter((m) => weekOfDay.get(m.at.slice(0, 10)) === week) })),
    merged: {
      count: merges.length,
      previous: previousMerged,
      tickets: [...merges].sort((a, b) => order(b.at, a.at)),
    },
    cycle: {
      ...stat(current.map(cycleMs)),
      previousP50: quantile(previous.map(cycleMs), 0.5),
      tickets: cycleTickets,
      daily: dayList.map((day) => quantile(byDay.get(day) ?? [], 0.5)),
    },
    phases,
    waits: {
      coordinator: { ...stat(coordinatorWaits), open: coordinatorOpen, tickets: coordinatorTickets.sort(byValue) },
      owner: { ...stat(ownerWaits), open: ownerOpen, tickets: ownerTickets.sort(byValue) },
    },
    firstPass: {
      green: green.length,
      handedBack: handedBack.length,
      rate: handedBack.length ? green.length / handedBack.length : null,
      tickets: green.map((c) => ticketOf(c.project, c.ticket, c.heads, c.mergedAt)).sort(byValue),
      redone: handedBack
        .filter((c) => c.heads > 1)
        .map((c) => ticketOf(c.project, c.ticket, c.heads - 1, c.mergedAt))
        .sort(byValue),
    },
    silences: {
      count: silences.length,
      workerHours,
      perWorkerHour: perHour(silences.length, workerHours),
      tickets: silences.map((s) => ticketOf(s.project, s.ticket, s.to - s.from, s.from)).sort(byValue),
    },
    profiles: compare("profile"),
    harnesses: compare("harness"),
    biggestWaits: biggest.sort((a, b) => b.ms - a.ms).slice(0, BIGGEST_WAITS),
  };
}

/** The overview's line (THE-893): this week's merges, their median claim to merge, the change from last week. */
export interface InsightsSummary {
  merged: number;
  previous: number;
  /** (merged - previous) / previous; null without a previous week to compare with. */
  change: number | null;
  cycleP50: number | null;
}

export function insightsSummary(insights: FleetInsights): InsightsSummary {
  const { count, previous } = insights.merged;
  return {
    merged: count,
    previous,
    change: previous > 0 ? (count - previous) / previous : null,
    cycleP50: insights.cycle.p50,
  };
}
