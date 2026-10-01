// What happened since the owner last looked (THE-894): the fleet's activity
// feed, one entry per event, and the "since you were away" summary the
// overview shows when the last visit was more than `AWAY_MINUTES` ago. Pure:
// the dashboard reads the records from Postgres (its feed is one query over
// the fleet's events, inbox, validations and launches) and renders these.
import { NEEDS_HUMAN } from "./fleet.ts";
import type { AgentPhase } from "./types.ts";
import type { ValidationKind } from "./validations.ts";

/** Everything the feed lists, in the order the Activity page's kind filter offers them. */
export const FEED_KINDS = [
  "claim",
  "report",
  "question",
  "answer",
  "plan",
  "hand-back",
  "request",
  "release",
  "merge",
  "validation",
  "decision",
  "launch",
  "revoke",
  "coordinator",
] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const isFeedKind = (v: unknown): v is FeedKind => FEED_KINDS.includes(v as FeedKind);

/** Who did it: a person (by the name they signed with), the project's coordinator, or a ticket's agent. */
export type FeedActorKind = "person" | "coordinator" | "agent";

export interface FeedEntry {
  /** Unique and stable across reads: the feed pages on (`at`, `key`). */
  key: string;
  project: string;
  /** Null for what is no ticket's: a coordinator starting or stopping. */
  ticket: string | null;
  kind: FeedKind;
  at: string;
  actor: { kind: FeedActorKind; name: string | null };
  /** The report's line, the question, plan, answer, note or request; null when it has none. */
  text: string | null;
  /** `claim`, `report`, `merge`: the phase it reported. */
  phase: string | null;
  /**
   * `request`: its kind (`launch-request`, …); `validation`: what is validated
   * (`merge`, `validation`, `question`); `decision`: the outcome; `coordinator`:
   * `start` or `stop`; `note`, a hand-back's or question's kind, else null.
   */
  detail: string | null;
  /** `validation`, `decision`: the validation's id, its link (`/approve/<id>`). */
  ref: number | null;
}

/** Where a page of the feed ends: the next page starts after it. */
export interface FeedCursor {
  at: string;
  key: string;
}

export const cursorText = (c: FeedCursor) => `${c.at}~${c.key}`;

export function cursorOf(text: string | null | undefined): FeedCursor | null {
  if (!text) return null;
  const at = text.slice(0, text.indexOf("~"));
  const key = text.slice(at.length + 1);
  if (!at || !key || Number.isNaN(Date.parse(at)) || !/^[a-z]:[\w:-]{1,80}$/.test(key)) return null;
  return { at: new Date(at).toISOString(), key };
}

/** "who" in the feed's address: the coordinator, the agents, or a person by name. */
export type FeedWho = { kind: "coordinator" } | { kind: "agent" } | { kind: "person"; name: string };

export function feedWhoOf(v: string | null | undefined): FeedWho | null {
  const name = v?.trim();
  if (!name) return null;
  if (name === "coordinator") return { kind: "coordinator" };
  if (name === "agents") return { kind: "agent" };
  return name.length <= 120 ? { kind: "person", name } : null;
}

export const feedWhoText = (w: FeedWho) =>
  w.kind === "coordinator" ? "coordinator" : w.kind === "agent" ? "agents" : w.name;

// ------------------------------------------------------------------ visits

/** A visit after this long away is a new one: the overview sums up what happened in between. */
export const AWAY_MINUTES = 30;

/** One person's visits to the dashboard, as the app keeps them. */
export interface Visit {
  /** When they were last seen on the dashboard; null before their first visit. */
  seenAt: string | null;
  /** Where the visit going on started from: their previous visit's last moment; null on the first. */
  since: string | null;
  /** When the visit going on began: they came back. */
  backAt: string | null;
  /** The `since` whose summary they dismissed. */
  dismissedSince: string | null;
}

const away = (v: Visit, now: Date) => v.seenAt !== null && now.getTime() - Date.parse(v.seenAt) > AWAY_MINUTES * 60_000;

/**
 * Where "since you were away" starts for a visit read at `now`: the last time
 * they were seen when that is more than `AWAY_MINUTES` ago (the visit is a new
 * one, not recorded yet), else the start the current visit already has.
 */
export function visitSince(v: Visit, now: Date): string | null {
  return away(v, now) ? v.seenAt : v.since;
}

/** What the viewer was away for: from their previous visit's end to when they came back; null on a first visit. */
export function awayWindow(v: Visit, now: Date): { since: string; until: string } | null {
  if (away(v, now)) return { since: v.seenAt as string, until: now.toISOString() };
  return v.since ? { since: v.since, until: v.backAt ?? now.toISOString() } : null;
}

/** The summary shows on a visit that has a start and was not dismissed. */
export function showSummary(v: Visit, now: Date): boolean {
  const since = visitSince(v, now);
  return since !== null && v.dismissedSince !== since;
}

// ------------------------------------------------------------------ the summary

/** What one project recorded since a visit's start, for its summary. */
export interface CatchupRecords {
  project: string;
  /** `policy.silent_after_minutes`: a longer gap between a held ticket's events is a silence. */
  silentAfterMinutes: number;
  merged: { ticket: string; at: string }[];
  claimed: { ticket: string; at: string }[];
  /**
   * Gaps between a held ticket's events (heartbeats included) longer than the
   * threshold, with the phase the ticket was in; `to` null while it lasts.
   */
  gaps: { ticket: string; from: string; to: string | null; phase: string | null }[];
  /** Reports that entered `blocked`. */
  blocked: { ticket: string; at: string }[];
  /** What waits for the owner now, however old: validations not decided yet. */
  waiting: { id: number; ticket: string; kind: ValidationKind }[];
}

export interface CatchupTicket {
  project: string;
  ticket: string;
}

export interface StuckTicket extends CatchupTicket {
  reason: "silent" | "blocked";
  /** How long the longest silence lasted, or lasts; null when blocked. */
  minutes: number | null;
  /** Still silent now. */
  ongoing: boolean;
}

export interface SinceSummary {
  since: string;
  merged: CatchupTicket[];
  started: CatchupTicket[];
  stuck: StuckTicket[];
  waiting: (CatchupTicket & { id: number; kind: ValidationKind })[];
  /** Nothing merged, started, got stuck or waits. */
  quiet: boolean;
}

const MIN = 60_000;

function distinct<T extends { ticket: string; at: string }>(
  project: string,
  list: T[],
  since: number,
): CatchupTicket[] {
  const seen = new Set<string>();
  const out: (CatchupTicket & { at: string })[] = [];
  for (const e of [...list].sort((a, b) => b.at.localeCompare(a.at))) {
    if (Date.parse(e.at) < since || seen.has(e.ticket)) continue;
    seen.add(e.ticket);
    out.push({ project, ticket: e.ticket, at: e.at });
  }
  return out;
}

/**
 * What happened since `since`, newest first in each list: the tickets merged
 * and started while the viewer was away (from `since` to `until`, when they
 * came back), those that got stuck then (a silence longer than the project's
 * threshold, in a phase that waits on no one, that ended after `since` or
 * lasts and began before `until`, the longest one per ticket; or a report
 * that entered `blocked`), and what waits for the owner now. A silence going
 * on wins over a block, a block over a silence that ended.
 */
export function sinceSummary(input: {
  since: string;
  until?: string;
  now: Date;
  records: CatchupRecords[];
}): SinceSummary {
  const since = Date.parse(input.since);
  const now = input.now.getTime();
  const until = input.until ? Date.parse(input.until) : now;
  const during = <T extends { at: string }>(list: T[]) => list.filter((e) => Date.parse(e.at) <= until);
  const merged: (CatchupTicket & { at: string })[] = [];
  const started: (CatchupTicket & { at: string })[] = [];
  const stuck: StuckTicket[] = [];
  const waiting: SinceSummary["waiting"] = [];
  for (const r of input.records) {
    merged.push(...(distinct(r.project, during(r.merged), since) as (CatchupTicket & { at: string })[]));
    started.push(...(distinct(r.project, during(r.claimed), since) as (CatchupTicket & { at: string })[]));
    const byTicket = new Map<string, StuckTicket>();
    for (const g of r.gaps) {
      const from = Date.parse(g.from);
      const end = g.to === null ? now : Date.parse(g.to);
      const waits = g.phase === "merged" || NEEDS_HUMAN.includes(g.phase as AgentPhase);
      if (waits || end < since || from > until || end - from <= r.silentAfterMinutes * MIN) continue;
      const minutes = Math.round((end - from) / MIN);
      const held = byTicket.get(g.ticket);
      const ongoing = g.to === null;
      if (!held || (ongoing && !held.ongoing) || (ongoing === held.ongoing && minutes > (held.minutes ?? 0)))
        byTicket.set(g.ticket, { project: r.project, ticket: g.ticket, reason: "silent", minutes, ongoing });
    }
    for (const b of during(r.blocked)) {
      if (Date.parse(b.at) < since) continue;
      const held = byTicket.get(b.ticket);
      if (!held?.ongoing)
        byTicket.set(b.ticket, {
          project: r.project,
          ticket: b.ticket,
          reason: "blocked",
          minutes: null,
          ongoing: false,
        });
    }
    stuck.push(...byTicket.values());
    waiting.push(...r.waiting.map((w) => ({ project: r.project, ticket: w.ticket, id: w.id, kind: w.kind })));
  }
  const byTime = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);
  const plain = ({ project, ticket }: CatchupTicket): CatchupTicket => ({ project, ticket });
  stuck.sort(
    (a, b) =>
      Number(b.ongoing) - Number(a.ongoing) ||
      (b.minutes ?? -1) - (a.minutes ?? -1) ||
      a.ticket.localeCompare(b.ticket, "en", { numeric: true }),
  );
  waiting.sort((a, b) => a.id - b.id);
  return {
    since: new Date(since).toISOString(),
    merged: merged.sort(byTime).map(plain),
    started: started.sort(byTime).map(plain),
    stuck,
    waiting,
    quiet: merged.length + started.length + stuck.length + waiting.length === 0,
  };
}
