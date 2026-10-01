// The live timeline of the dashboard's overview (THE-868): what each session
// in flight did over the last hours, as one row draws it. Pure: built from the
// ticket's `Agent status:` and claim comments of the Linear snapshot and
// Armada's events, so drawing it never reads Linear. The row's own reading
// (its phase, since when, silent or not) always wins over the history, so the
// timeline and the rest of the dashboard never disagree.
import { NEEDS_HUMAN } from "./fleet.ts";
import type { InFlightTicket } from "./status.ts";
import { type AgentPhase, type Comment, LABEL_PHASES } from "./types.ts";

/** The longest span the timeline shows, in hours: the rows carry this much history. */
export const TIMELINE_HOURS = 8;
/** A status line longer than this is cut: the overview is polled every few seconds. */
const SUMMARY_CHARS = 140;
/** A comment and an Armada event of the same phase this close are one report. */
const SAME_REPORT_MS = 2 * 60_000;
const MIN = 60_000;

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
 * One session's last `TIMELINE_HOURS`: its phases oldest first (the last one
 * is the row's current phase, from the row's `since`; the first may start
 * before the window), the time of each report, its silences (a gap between
 * reports longer than `policy.silent_minutes` while no human had to act), and
 * when its pull request opened (null when unknown).
 */
export interface SessionTimeline {
  phases: PhaseSegment[];
  reports: string[];
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

/** The reports of the current run, oldest first: comments and events, each report once. */
function marksOf(comments: Comment[], events: HistoryEvent[]): Mark[] {
  // The run starts after the last release; a merge ends one as well.
  let start = Number.NEGATIVE_INFINITY;
  for (const c of comments) if (c.status?.phase === "released") start = Math.max(start, Date.parse(c.createdAt));
  for (const e of events) if (e.kind === "release" || e.kind === "merge") start = Math.max(start, Date.parse(e.at));

  const fromEvents: Mark[] = events
    .filter((e) => (e.kind === "report" || e.kind === "claim") && Date.parse(e.at) > start)
    .map((e) => ({ at: Date.parse(e.at), phase: asPhase(e.phase), summary: cut(e.message), event: true }));
  const fromComments: Mark[] = comments
    .filter((c) => (c.status || c.claim) && c.status?.phase !== "released" && Date.parse(c.createdAt) > start)
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
  ticket: Pick<InFlightTicket, "phase" | "since" | "lastReport" | "lastUpdate" | "silent" | "statusLine" | "pr">;
  history: TimelineHistory;
  silentAfterMinutes: number;
  now: Date;
}): SessionTimeline {
  const { ticket } = input;
  const now = input.now.getTime();
  const windowStart = now - TIMELINE_HOURS * 3_600_000;
  const marks = marksOf(input.history.comments, input.history.events);
  const since = Math.min(Date.parse(ticket.since), now);

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

  // Silences: the gaps between reports, while the phase was the worker's to move.
  const times = marks.map((m) => m.at);
  const phaseAt = (t: number) => all.findLast((s) => s.from <= t)?.phase ?? all[0]?.phase ?? ticket.phase;
  const quiet = (phase: AgentPhase) => !NEEDS_HUMAN.includes(phase) && phase !== "merged";
  const silences: SessionTimeline["silences"] = [];
  for (let k = 1; k < times.length; k++) {
    const a = times[k - 1] as number;
    const b = times[k] as number;
    if (b - a > input.silentAfterMinutes * MIN && b > windowStart && quiet(phaseAt(a)))
      silences.push({ from: iso(a), to: iso(b) });
  }
  // The silence going on now is the row's own: from its last report, as the `silent` flag counts it.
  if (ticket.silent) silences.push({ from: iso(Date.parse(ticket.lastReport ?? ticket.lastUpdate)), to: null });

  return {
    phases,
    reports: [...new Set(times.filter((t) => t >= windowStart && t <= now))].map(iso),
    silences,
    prOpenedAt: ticket.pr?.createdAt ?? null,
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
