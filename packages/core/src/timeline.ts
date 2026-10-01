// The live timeline of the dashboard's overview (THE-868): what each session
// in flight did over the last hours, as one row draws it. Pure: built from the
// ticket's `Agent status:` and claim comments of the Linear snapshot and
// Armada's events, so drawing it never reads Linear. The row's own reading
// (its phase, since when, silent or not) always wins over the history, so the
// timeline and the rest of the dashboard never disagree.
import { NEEDS_HUMAN } from "./fleet.ts";
import type { InFlightTicket } from "./status.ts";
import { type AgentPhase, type Comment, LABEL_PHASES } from "./types.ts";

/** How far back the timeline scrolls, in hours: the rows carry this much history. */
export const TIMELINE_HOURS = 24;
/** A status line longer than this is cut: the overview is polled every few seconds. */
const SUMMARY_CHARS = 140;
/** A comment and an Armada event of the same phase this close are one report. */
const SAME_REPORT_MS = 2 * 60_000;
/** Inbox reads this close are one stretch of watching: `armada watch` reads every 15 s. */
const SAME_WATCH_MS = 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** An event of Armada's live data, as the timeline reads it. */
export interface HistoryEvent {
  ticket: string;
  kind: string;
  phase: string | null;
  message: string | null;
  at: string;
}

/** What a project's timeline is built from: its snapshot's comments and Armada's recent events. */
export interface TimelineHistory {
  comments: Comment[];
  events: HistoryEvent[];
}

export interface PhaseSegment {
  phase: AgentPhase;
  from: string;
  /** Null for the current phase, which runs until now. */
  to: string | null;
  /** The status line the worker gave last in this phase. */
  summary: string | null;
}

/**
 * One session's last `TIMELINE_HOURS`, from its current claim on: its phases
 * oldest first (the last one is the row's current phase, from the row's
 * `since`; the first may start before the window), the time of each report,
 * its silences (a gap between reports longer than `policy.silent_minutes`
 * while no human had to act), and when its pull request opened (null when
 * unknown).
 */
export interface SessionTimeline {
  /** When the current run started (its claim): nothing is drawn before it. */
  startedAt: string;
  phases: PhaseSegment[];
  reports: string[];
  heartbeats?: string[];
  /** The one going on now has no end (`to` null): the body stays the same from one poll to the next. */
  silences: { from: string; to: string | null }[];
  prOpenedAt: string | null;
}

interface Mark {
  at: number;
  /** Null for a claim: the run goes on in the phase it was in, else starts planning. */
  phase: AgentPhase | null;
  summary: string | null;
  event: boolean;
}

const cut = (text: string | null | undefined) =>
  text ? (text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text) : null;
const asPhase = (p: string | null): AgentPhase | null => LABEL_PHASES.find((x) => x === p) ?? null;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The reports of the current run, oldest first: comments and events, each
 * report once. The run ends at a release or a merge, and the next one starts
 * at its first claim after it: a status line left on the ticket before
 * (another agent's input, a previous run) is not this session's, and a worker
 * that claims again to resume keeps its history.
 */
function marksOf(comments: Comment[], events: HistoryEvent[]): Mark[] {
  let ended = Number.NEGATIVE_INFINITY;
  for (const c of comments) if (c.status?.phase === "released") ended = Math.max(ended, Date.parse(c.createdAt));
  for (const e of events) if (e.kind === "release" || e.kind === "merge") ended = Math.max(ended, Date.parse(e.at));
  // The first claim after the last end, when one is known; else the run starts after the end.
  const claims = [
    ...comments.flatMap((c) => (c.claim ? [Date.parse(c.createdAt)] : [])),
    ...events.flatMap((e) => (e.kind === "claim" ? [Date.parse(e.at)] : [])),
  ].filter((t) => t > ended);
  const claimed = claims.length ? Math.min(...claims) : Number.NEGATIVE_INFINITY;
  const inRun = (t: number) => t > ended && t >= claimed;

  const fromEvents: Mark[] = events
    .filter((e) => (e.kind === "report" || e.kind === "claim") && inRun(Date.parse(e.at)))
    .map((e) => ({ at: Date.parse(e.at), phase: asPhase(e.phase), summary: cut(e.message), event: true }));
  const fromComments: Mark[] = comments
    .filter((c) => (c.status || c.claim) && c.status?.phase !== "released" && inRun(Date.parse(c.createdAt)))
    .map((c) => ({
      at: Date.parse(c.createdAt),
      phase: c.status?.phase ?? null,
      summary: cut(c.status?.summary),
      event: false,
    }))
    // A report is recorded twice, on Linear and in Armada: the event's server time wins.
    .filter(
      (c) =>
        !fromEvents.some(
          (e) => Math.abs(e.at - c.at) <= SAME_REPORT_MS && (e.phase === c.phase || !e.phase || !c.phase),
        ),
    );
  return [...fromEvents, ...fromComments].sort((a, b) => a.at - b.at);
}

export function sessionTimeline(input: {
  ticket: Pick<
    InFlightTicket,
    "phase" | "since" | "lastReport" | "lastHeartbeat" | "lastUpdate" | "silent" | "statusLine" | "pr"
  >;
  history: TimelineHistory;
  silentAfterMinutes: number;
  now: Date;
}): SessionTimeline {
  const { ticket } = input;
  const now = input.now.getTime();
  const windowStart = now - TIMELINE_HOURS * 3_600_000;
  const marks = marksOf(input.history.comments, input.history.events);
  // The run starts at its first report (its claim); the row's phase never starts before it.
  const runStart = Math.min(marks[0]?.at ?? Number.POSITIVE_INFINITY, Date.parse(ticket.since), now);
  const since = Math.max(Math.min(Date.parse(ticket.since), now), runStart);

  // Phases before the current one, from the reports that came before it.
  const past: { phase: AgentPhase; from: number; summary: string | null }[] = [];
  for (const m of marks) {
    if (m.at >= since) break;
    const last = past.at(-1);
    const phase = m.phase ?? last?.phase ?? "planning";
    if (last?.phase === phase) last.summary = m.summary ?? last.summary;
    else past.push({ phase, from: m.at, summary: m.summary });
  }
  // The row's phase wins: it runs from `since`, and a report just before in the same phase is the same stretch.
  const before = past.at(-1)?.phase === ticket.phase ? past.pop() : undefined;
  const current = {
    phase: ticket.phase,
    from: before?.from ?? since,
    summary:
      cut(ticket.statusLine?.summary) ??
      marks.findLast((m) => m.summary && m.at >= (before?.from ?? since))?.summary ??
      null,
  };
  const all = [...past, current];
  const phases: PhaseSegment[] = all
    .map((s, k) => {
      const next = all[k + 1];
      return { phase: s.phase, from: iso(s.from), to: next ? iso(next.from) : null, summary: s.summary };
    })
    .filter((s) => (s.to === null ? true : Date.parse(s.to) > windowStart));

  // Old clients keep report-based silence until their first heartbeat.
  const times = marks.map((m) => m.at);
  const heartbeats = (input.history?.events ?? [])
    .filter((event) => event.kind === "heartbeat")
    .map((event) => Date.parse(event.at))
    .filter((at) => at >= runStart && at <= now);
  const firstHeartbeat = Math.min(...heartbeats);
  const life = [...new Set([...times.filter((at) => at <= firstHeartbeat), ...heartbeats])].sort(
    (first, second) => first - second,
  );
  const phaseAt = (t: number) => all.findLast((s) => s.from <= t)?.phase ?? all[0]?.phase ?? ticket.phase;
  const quiet = (phase: AgentPhase) => !NEEDS_HUMAN.includes(phase) && phase !== "merged";
  const silences: SessionTimeline["silences"] = [];
  for (let k = 1; k < life.length; k++) {
    const a = life[k - 1] as number;
    const b = life[k] as number;
    if (b - a > input.silentAfterMinutes * MIN && b > windowStart && quiet(phaseAt(a)))
      silences.push({ from: iso(a), to: iso(b) });
  }
  // The silence going on now is the row's own: from its last report, as the `silent` flag counts it, within the run.
  if (ticket.silent)
    silences.push({
      from: iso(Math.max(Date.parse(ticket.lastHeartbeat ?? ticket.lastReport ?? ticket.lastUpdate), runStart)),
      to: null,
    });

  return {
    startedAt: iso(runStart),
    phases,
    reports: [...new Set(times.filter((t) => t >= windowStart && t <= now))].map(iso),
    heartbeats: heartbeats.filter((at) => at >= windowStart).map(iso),
    silences,
    prOpenedAt: ticket.pr?.createdAt ?? null,
  };
}

/** A coordinator's inbox reads over the last `TIMELINE_HOURS`, as its timeline row draws them. */
export interface CoordinatorTrack {
  /** Reads closer than a minute, one stretch each: a coordinator that keeps watching is one line. */
  reads: { from: string; to: string; count: number }[];
  /** Gaps between reads longer than the silence threshold: it was not watching. */
  idle: { from: string; to: string }[];
}

/** Reads oldest first, as the store lists them; the gap crossing the window's start is kept. */
export function coordinatorTrack(input: {
  reads: { at: string }[];
  silentAfterMinutes: number;
  now: Date;
}): CoordinatorTrack {
  const windowStart = input.now.getTime() - TIMELINE_HOURS * HOUR;
  const spans: { from: number; to: number; count: number }[] = [];
  for (const r of input.reads) {
    const t = Date.parse(r.at);
    const last = spans.at(-1);
    if (last && t - last.to < SAME_WATCH_MS) {
      last.to = Math.max(last.to, t);
      last.count++;
    } else spans.push({ from: t, to: t, count: 1 });
  }
  const idle: CoordinatorTrack["idle"] = [];
  for (let k = 1; k < spans.length; k++) {
    const a = (spans[k - 1] as (typeof spans)[number]).to;
    const b = (spans[k] as (typeof spans)[number]).from;
    if (b - a > input.silentAfterMinutes * MIN && b > windowStart) idle.push({ from: iso(a), to: iso(b) });
  }
  return {
    reads: spans.filter((s) => s.to >= windowStart).map((s) => ({ from: iso(s.from), to: iso(s.to), count: s.count })),
    idle,
  };
}

/** A project's history, per ticket. */
export function historyByTicket(history: TimelineHistory | undefined): Map<string, TimelineHistory> {
  const by = new Map<string, TimelineHistory>();
  const of = (ticket: string) => {
    const held = by.get(ticket);
    if (held) return held;
    const h: TimelineHistory = { comments: [], events: [] };
    by.set(ticket, h);
    return h;
  };
  for (const c of history?.comments ?? []) of(c.issueId).comments.push(c);
  for (const e of history?.events ?? []) of(e.ticket).events.push(e);
  return by;
}
