// The home's fleet (THE-1991): every session in flight and every ticket
// merged on the viewer's day, in one of five states, most urgent first:
// blocked, waiting for your decision, in progress, ready to merge, merged
// today. The daemon's fold decides each session's state; these rules say it
// the way V1's overview does, copied from packages/dashboard/lib/coordinator-view.ts
// and its strings (lib/i18n.ts), never imported: the group of each folded
// state, the reason in words, the six-step bar. Pure: `now` and the zone
// are given.
import type { FleetState, FoldedSession } from "./state";

/** The five states of the list, most urgent first. */
export const GROUPS = ["blocked", "you", "running", "ready", "merged"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<Group, string> = {
  blocked: "Blocked",
  you: "Waiting for your decision",
  running: "In progress",
  ready: "Ready to merge",
  merged: "Merged today",
};

export const GROUP_HINT: Record<Group, string> = {
  blocked: "can't go on without someone",
  you: "a plan, a merge or a question for you",
  running: "moving on its own",
  ready: "approved, the coordinator merges",
  merged: "",
};

/** The group of each folded state; a released session is not shown. */
export const GROUP_OF: Record<FoldedSession["state"], Group | null> = {
  blocked: "blocked",
  "waiting-for-owner": "you",
  "in-progress": "running",
  "ready-to-merge": "ready",
  merged: "merged",
  released: null,
};

/** The six steps of a row's bar, from plan to merge. */
export const STEPS = ["Plan", "Approval", "Code", "Review & CI", "Ready", "Merged"] as const;

/** One line of the list. */
export interface FleetItem {
  /** `project/ticket`: the row's identity, kept when it changes state. */
  key: string;
  project: string;
  ticket: string;
  title: string;
  group: Group;
  /** Why it is in its state, in words. */
  reason: string;
  /** The step at work on the six steps (0 to 5); 6 once merged. */
  step: number;
  /** When it last changed: the worker's last report, its claim, or its merge. */
  at: string;
}

/** Where a session is on the six steps: its phase's, else its flow step (V1's `sessionStep`). */
function sessionStep(s: Pick<FoldedSession, "phase" | "flowStep">): number {
  if (s.phase === "merged") return STEPS.length;
  if (s.phase === "awaiting-approval") return 1;
  if (s.phase === "ready-to-merge") return 4;
  return { plan: 0, implementing: 2, review: 3, ci: 3, merged: STEPS.length }[s.flowStep];
}

/** The first line of a text, for a row's one line. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/** A question as V1 stores it, without its "Options:" list. */
const questionText = (body: string) => firstLine(body.split("\n\nOptions:\n")[0] ?? body);

const CI_WORD = { success: "green", failure: "red", pending: "running", none: "" } as const;

/** The worker's own line: the session's reason, unless it only repeats the phase. */
function ownLine(s: FoldedSession): string | null {
  const line = firstLine(s.reason);
  return line && line !== s.phase ? line : null;
}

/** Why a session is in its group, in V1's words. */
function sessionReason(s: FoldedSession, group: Group, state: FleetState): string {
  // The ticket's pull request as the fold reads it: its latest one not closed.
  const pr = state.pullRequests.findLast((p) => p.ticket === s.ticket && p.state !== "closed");
  const prText = pr ? `#${pr.number}${CI_WORD[pr.ci] ? ` ${CI_WORD[pr.ci]}` : ""}` : "";
  switch (group) {
    case "merged": {
      const merged = state.pullRequests.findLast((p) => p.ticket === s.ticket && p.state === "merged") ?? pr;
      // Without its pull request read, a merge the daemon confirmed still names it ("Merged #N").
      const number = merged?.number ?? Number(s.reason.match(/^Merged #(\d+)$/)?.[1] ?? Number.NaN);
      return Number.isNaN(number) ? (ownLine(s) ?? "Merged") : `#${number} merged`;
    }
    case "blocked": {
      const question = state.inbox.find((i) => i.ticket === s.ticket && i.kind === "question");
      if (question) return `Unanswered question: ${questionText(question.body)}`;
      if (pr?.ci === "failure") return `Red CI on #${pr.number}`;
      if (pr?.conflicting) return `Conflict with main on #${pr.number}`;
      const own = ownLine(s);
      return own ? `Blocked: ${own}` : "Blocked";
    }
    case "you": {
      const v = state.validations.find((v) => v.ticket === s.ticket && v.session === s.session && !v.decision);
      if (v) return firstLine(v.question) || "Waiting for your validation";
      return s.phase === "awaiting-approval" ? "Plan to approve" : "Waiting for your validation";
    }
    case "ready": {
      const queued = state.queue.filter((q) => q.state === "queued");
      const q = state.queue.find((q) => q.ticket === s.ticket && q.session === s.session);
      if (q?.state === "running") return "Merging";
      if (q) return `Queued in the merge queue (position ${queued.indexOf(q) + 1})`;
      return ["Handed back", prText].filter(Boolean).join(" · ");
    }
    case "running":
      return ownLine(s) ?? "At work";
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone and use, built once: a list re-renders on every frame. */
function format(zone: string, use: "day" | "hour" | "date"): Intl.DateTimeFormat {
  const key = `${zone} ${use}`;
  let f = formats.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions =
      use === "day"
        ? { year: "numeric", month: "2-digit", day: "2-digit" }
        : use === "hour"
          ? { hour: "2-digit", minute: "2-digit" }
          : { day: "numeric", month: "short" };
    try {
      f = new Intl.DateTimeFormat(use === "day" ? "en-CA" : "en-GB", { ...options, timeZone: zone });
    } catch {
      // A zone the runtime does not know reads as UTC.
      f = format("UTC", use);
    }
    formats.set(key, f);
  }
  return f;
}

/** A time's calendar day in a zone, `YYYY-MM-DD`. */
export const dayIn = (at: string | number, zone: string) => format(zone, "day").format(new Date(at));

/** A row's time: the hour on the viewer's day, else the date. A still word, never a clock that ticks. */
export function rowTime(at: string, now: number, zone: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  return format(zone, dayIn(time, zone) === dayIn(now, zone) ? "hour" : "date").format(time);
}

/**
 * Every line of the list from each project's folded state: the sessions in
 * flight in the fold's order, then the tickets merged on the viewer's day
 * (`zone`), newest first.
 */
export function fleetItems(
  projects: readonly { id: string; state: FleetState }[],
  { now, zone }: { now: number; zone: string },
): FleetItem[] {
  const today = dayIn(now, zone);
  const items: FleetItem[] = [];
  for (const { id, state } of projects)
    for (const s of state.sessions) {
      const group = GROUP_OF[s.state];
      if (!group || (group === "merged" && dayIn(s.at, zone) !== today)) continue;
      items.push({
        key: `${id}/${s.ticket}`,
        project: id,
        ticket: s.ticket,
        title: s.title,
        group,
        reason: sessionReason(s, group, state),
        step: sessionStep(s),
        at: s.at,
      });
    }
  const merged = (i: FleetItem) => (i.group === "merged" ? 1 : 0);
  // Array.prototype.sort is stable: the sessions keep the fold's order, then the merges, newest first.
  return items.sort((a, b) => merged(a) - merged(b) || (merged(a) ? Date.parse(b.at) - Date.parse(a.at) : 0));
}

/** The list's groups in their order, each with its lines; the empty ones left out. */
export function groupItems(items: readonly FleetItem[]): { group: Group; items: FleetItem[] }[] {
  return GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group) })).filter(
    (g) => g.items.length > 0,
  );
}

/** How many lines each state holds. */
export function groupCounts(items: readonly Pick<FleetItem, "group">[]): Record<Group, number> {
  const out = { blocked: 0, you: 0, running: 0, ready: 0, merged: 0 };
  for (const i of items) out[i.group]++;
  return out;
}

const agents = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/** The page's quiet line: what is blocked and what waits for the owner (V1's headline). */
export function headline(n: Record<Group, number>): string {
  const waits = n.you === 0 ? "nothing waits for your decision" : `${n.you} waiting for your decision`;
  if (n.blocked) return `${agents(n.blocked)} blocked, ${waits}.`;
  return n.you ? `Nothing blocked. ${waits}.` : "Everything is moving, nothing is waiting.";
}

/** The rest, for the facts line (V1's subline). */
export function subline(n: Record<Group, number>, projects: number): string[] {
  const live = n.blocked + n.you + n.running + n.ready;
  return [
    `${agents(live)} in flight across ${projects === 1 ? "1 project" : `${projects} projects`}`,
    `${n.running} moving on their own`,
    `${n.ready} ready to merge`,
    `${n.merged} merged today`,
  ];
}

/** Past this many rows, the rows off screen skip style, layout and paint (V1's `LONG_LIST`). */
export const LONG_LIST = 100;
