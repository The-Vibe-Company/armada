// The Activity page's view rules (THE-894, THE-1021 on design/dashboard-v7):
// its address (a chip, and the cursor of an older page), what each entry
// says and where it links, its kind's word and color, and the days it is
// grouped by, in the viewer's time zone. Pure: the entries come from
// `loadActivity`, every rule of what they mean from core.
import { cursorOf, cursorText, type FeedCursor, type FeedEntry, type FeedKind } from "@armada/core/read";
import type { ActivityQuery } from "./fleet-data";
import { paths } from "./fleet-view";
import type { Strings } from "./i18n";

/** The viewer's time zone, which the shell keeps in a cookie: the server groups days and prints times in it. */
export const ZONE_COOKIE = "armada-tz";

/** A time zone the server can format in; UTC when the cookie names none. */
export function zoneOf(cookie: string | undefined): string {
  if (!cookie || cookie.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: cookie });
    return cookie;
  } catch {
    return "UTC";
  }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/** The page's chips, as the design draws them: everything, what blocked, what is for the owner, merges, reports. */
export const ACTIVITY_SHOWS = ["all", "blocked", "you", "merge", "report"] as const;
export type ActivityShow = (typeof ACTIVITY_SHOWS)[number];

/** What each chip reads: its kinds, and for the blocked ones only the reports that entered `blocked`. */
export const SHOWS: Record<ActivityShow, { kinds: FeedKind[] | null; phase: string | null }> = {
  all: { kinds: null, phase: null },
  blocked: { kinds: ["question", "report"], phase: "blocked" },
  you: { kinds: ["plan", "validation"], phase: null },
  merge: { kinds: ["merge", "hand-back", "decision"], phase: null },
  report: { kinds: ["report", "claim", "launch"], phase: null },
};

const isShow = (v: string | null): v is ActivityShow => ACTIVITY_SHOWS.includes(v as ActivityShow);

/** What the page's address says: `?show=<chip>&before=<cursor>`; anything else (older links' filters) is ignored. */
export function activityQuery(params: Record<string, string | string[] | undefined>): ActivityQuery {
  const show = one(params.show);
  return { show: isShow(show) ? show : "all", before: cursorOf(one(params.before)) };
}

/** The page's address for `q`: only what is set, in one order, so a shared address reads the same. */
export function activityHref(q: { show?: ActivityShow; before?: FeedCursor | null }): string {
  const p = new URLSearchParams();
  if (q.show && q.show !== "all") p.set("show", q.show);
  if (q.before) p.set("before", cursorText(q.before));
  const s = p.toString();
  return s ? `${paths.activity}?${s}` : paths.activity;
}

/** An entry's kind as a row shows it: one word in one color. */
export type EntryKind =
  | "report"
  | "start"
  | "handback"
  | "blocked"
  | "you"
  | "merge"
  | "decision"
  | "answer"
  | "request"
  | "stop"
  | "coordinator";

export function entryKind(e: Pick<FeedEntry, "kind" | "phase">): EntryKind {
  switch (e.kind) {
    case "report":
      return e.phase === "blocked" ? "blocked" : "report";
    case "question":
      return "blocked";
    case "claim":
    case "launch":
      return "start";
    case "hand-back":
      return "handback";
    case "plan":
    case "validation":
      return "you";
    case "release":
    case "revoke":
      return "stop";
    default:
      return e.kind;
  }
}

/** Each kind's color: blocked red, the owner's amber, a start blue, a hand-back or merge green, the rest grey. */
export const KIND_COLOR: Record<EntryKind, string> = {
  report: "var(--text-3)",
  start: "var(--blue)",
  handback: "var(--green)",
  blocked: "var(--red)",
  you: "var(--amber)",
  merge: "var(--green)",
  decision: "var(--green)",
  answer: "var(--text-3)",
  request: "var(--text-3)",
  stop: "var(--red)",
  coordinator: "var(--text-3)",
};

/** What an entry says happened, in a few words. */
export function entryWhat(t: Strings, e: FeedEntry): string {
  const w = t.activity.what;
  const phase = (p: string | null) => (p && p in t.shell.phases ? t.shell.phases[p as keyof typeof t.shell.phases] : p);
  switch (e.kind) {
    case "report":
      return w.report(phase(e.phase));
    case "answer":
      return e.detail === "note" ? w.note : e.detail === "plan" ? w.planAnswer : w.answer;
    case "request":
      return w.request[e.detail ?? "request"] ?? w.request.request ?? "";
    case "validation":
      return w.validation[e.detail ?? "validation"] ?? w.validation.validation ?? "";
    case "decision":
      return w.decision[e.detail ?? "approved"] ?? w.decision.approved ?? "";
    case "coordinator":
      return e.detail === "stop" ? w.stop : w.start;
    default:
      return w[e.kind];
  }
}

/** Where an entry opens: the validation it asks or decides, the coordinator's project, else the ticket's agent. */
export function entryHref(e: FeedEntry): string {
  if ((e.kind === "validation" || e.kind === "decision") && e.ref !== null) return paths.validation(e.ref);
  if (e.ticket) return paths.agent(e.ticket);
  return paths.project(e.project);
}

/** The day an instant falls on in `zone`, as `YYYY-MM-DD`. */
export const dayIn = (at: string, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(at),
  );

/** The time of day of an instant in `zone`: "14:20". */
export const clockIn = (at: string, zone: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(at),
  );

/** "Today", "Yesterday", else "Thu 5 Mar", in the viewer's language. */
export function dayLabel(t: Strings, day: string, today: string): string {
  if (day === today) return t.activity.today;
  const yesterday = dayIn(new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 3_600_000).toISOString(), "UTC");
  if (day === yesterday) return t.activity.yesterday;
  return new Intl.DateTimeFormat(t.overview.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

export interface FeedDay {
  day: string;
  label: string;
  /** Newer than the last visit, then the rest; either may be empty. */
  fresh: FeedEntry[];
  seen: FeedEntry[];
}

/**
 * The entries by day, newest first, each day split at the viewer's last
 * visit: the "new" divider goes between the two halves of the one day that
 * holds both, and only when something on the page is older than the visit.
 */
export function feedDays(
  t: Strings,
  entries: FeedEntry[],
  o: { zone: string; now: Date; since: string | null },
): { days: FeedDay[]; divider: string | null } {
  const today = dayIn(o.now.toISOString(), o.zone);
  const since = o.since ? Date.parse(o.since) : null;
  const split =
    since !== null && entries.some((e) => Date.parse(e.at) <= since) && entries.some((e) => Date.parse(e.at) > since);
  const days: FeedDay[] = [];
  for (const e of entries) {
    const day = dayIn(e.at, o.zone);
    let d = days.at(-1);
    if (d?.day !== day) {
      d = { day, label: dayLabel(t, day, today), fresh: [], seen: [] };
      days.push(d);
    }
    (split && since !== null && Date.parse(e.at) > since ? d.fresh : d.seen).push(e);
  }
  return { days, divider: split ? o.since : null };
}
