// A session's page (THE-2028), read from what the app already holds: the
// project's folded state (its session, pull request, inbox, queue and
// validations) and the project's events the subscription replayed (the
// session's history: claims, reports, questions, the forge's moves). The
// daemon folds; this only reads one ticket's lines out of them. Pure: `now`
// and the zone are given.
import type { Project, ProtocolEvent } from "@armada/protocol";
import { z } from "zod";
import { dayIn, GROUP_OF, type Group, sessionReason } from "@/fleet/overview";
import { HARNESS_LABEL, harnessOf } from "@/fleet/sky";
import type { FleetState, FoldedPullRequest, FoldedSession } from "@/fleet/state";

/** The page's six steps, from the plan to done. */
export const PAGE_STEPS = ["Plan", "Build", "Ship", "Review & CI", "Merge", "Done"] as const;

/** The state's word on the card, the list's group labels said of one session. */
export const STATE_LABEL: Record<Group, string> = {
  blocked: "Blocked",
  you: "Waiting for you",
  running: "In progress",
  ready: "Ready to merge",
  merged: "Merged",
};

const CHECKS_WORD: Record<FoldedPullRequest["ci"], string> = {
  success: "checks green",
  failure: "checks red",
  pending: "checks running",
  none: "no checks",
};

/** Where the session is on the page's six steps (0 to 5); done once merged. */
export function pageStep(s: Pick<FoldedSession, "phase" | "flowStep">, pr: FoldedPullRequest | undefined): number {
  if (s.phase === "merged" || s.flowStep === "merged") return 5;
  if (s.phase === "ready-to-merge") return 4;
  switch (s.flowStep) {
    case "plan":
      return 0;
    case "implementing":
      return 1;
    default:
      // Review or CI: shipping until a pull request is read, then its review and checks.
      return pr ? 3 : 2;
  }
}

/** A question as V1 writes it: its text, then its numbered or dashed choices after "Options:". */
export function questionOf(body: string): { question: string; choices: string[] } {
  const [question = "", options = ""] = body.split(/\n\s*Options:\s*\n/);
  const choices = options
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);
  return { question: question.trim(), choices };
}

/** What the state card says and offers. */
export type Card =
  | { kind: "blocked"; reason: string; question: { question: string; choices: string[] } | null }
  | {
      kind: "you";
      /** What the owner decides: a validation, a plan, or a question the coordinator asked. */
      ask: "validation" | "plan" | "question";
      question: string;
      checks: string[];
      choices: string[];
    }
  | { kind: "running"; report: string; at: string }
  | { kind: "ready"; reason: string; pr: PullRequestFact | null }
  | { kind: "merged"; reason: string; pr: PullRequestFact | null };

export interface PullRequestFact {
  number: number;
  /** Its checks in words: "checks green", "checks red"… */
  checks: string;
  ci: FoldedPullRequest["ci"];
  url: string | null;
}

/** One line of the Reports tab. */
export interface Entry {
  seq: number;
  at: string;
  /** What happened, a few words. */
  title: string;
  /** Its text: the report, the question, the answer… Empty when the title says it all. */
  body: string;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface SessionView {
  project: Project;
  ticket: string;
  title: string;
  group: Group;
  /** The facts line, in order. */
  facts: {
    runtime: string;
    harness: string | null;
    branch: string | null;
    pr: PullRequestFact | null;
    claimedAt: string | null;
    reportedAt: string | null;
  };
  card: Card;
  step: number;
  entries: Entry[];
  files: FileChange[];
}

const text = z.string();
const githubPullRequest = z.object({
  number: z.number().int(),
  ticket: text,
  url: text.optional(),
  headRef: text.optional(),
  files: z
    .array(z.object({ path: text.min(1), additions: z.number().int().min(0), deletions: z.number().int().min(0) }))
    .optional(),
});

/** The first ticket of that id across the projects, as its page reads it; null when no project holds it. */
export function findSession(
  ticket: string,
  projects: readonly Project[],
  read: (id: string) => { state: FleetState; events: readonly ProtocolEvent[] } | null,
): SessionView | null {
  for (const project of projects) {
    const held = read(project.id);
    const session = held?.state.sessions.find((s) => s.ticket === ticket);
    if (held && session) return sessionView(project, session, held.state, held.events);
  }
  return null;
}

/** One session's page from its project's folded state and events. */
export function sessionView(
  project: Project,
  s: FoldedSession,
  state: FleetState,
  events: readonly ProtocolEvent[],
): SessionView {
  // A released session is not in the list; its page still says where it stopped, as in progress.
  const group = GROUP_OF[s.state] ?? "running";
  const own = sessionEvents(events, s.ticket);
  const pr =
    state.pullRequests.findLast((p) => p.ticket === s.ticket && p.state !== "closed") ??
    state.pullRequests.findLast((p) => p.ticket === s.ticket);
  // The forge's richer reading of that pull request: its address, branch and files.
  const forge = own
    .filter((e) => e.kind.startsWith("pull-request.") && e.kind !== "pull-request.seen")
    .map((e) => githubPullRequest.safeParse(e.payload))
    .flatMap((r) => (r.success ? [r.data] : []))
    .filter((p) => !pr || p.number === pr.number)
    .at(-1);
  const prFact: PullRequestFact | null = pr
    ? { number: pr.number, ci: pr.ci, checks: CHECKS_WORD[pr.ci], url: forge?.url ?? null }
    : null;
  const claimed = own.findLast((e) => e.kind === "session.claimed" && field(e, "session") === s.session);
  const reported = own.findLast(
    (e) =>
      (e.kind === "session.reported" && field(e, "session") === s.session) ||
      (e.kind === "ticket.report-posted" && (!claimed || e.seq > claimed.seq)),
  );
  return {
    project,
    ticket: s.ticket,
    title: s.title,
    group,
    facts: {
      runtime: s.runtime ?? "unknown",
      harness: (() => {
        const h = harnessOf(s.runtime);
        return h ? HARNESS_LABEL[h] : null;
      })(),
      branch: forge?.headRef ?? null,
      pr: prFact,
      claimedAt: claimed?.at ?? null,
      reportedAt: reported?.at ?? null,
    },
    card: cardOf(s, group, state, prFact),
    step: pageStep(s, pr),
    entries: entries(own),
    files: forge?.files ?? [],
  };
}

function cardOf(s: FoldedSession, group: Group, state: FleetState, pr: PullRequestFact | null): Card {
  const reason = sessionReason(s, group, state);
  switch (group) {
    case "blocked": {
      const q = state.inbox.find((i) => i.ticket === s.ticket && i.kind === "question");
      return { kind: "blocked", reason, question: q ? questionOf(q.body) : null };
    }
    case "you": {
      const v = state.validations.find((v) => v.ticket === s.ticket && v.session === s.session && !v.decision);
      if (v)
        return {
          kind: "you",
          ask: "validation",
          question: v.question,
          checks: v.checks ?? [],
          choices: ["Approve", "Request changes"],
        };
      const owner = state.inbox.find((i) => i.ticket === s.ticket && i.kind === "owner-request");
      if (owner) return { kind: "you", ask: "question", checks: [], ...questionOf(owner.body) };
      const plan = state.inbox.find((i) => i.ticket === s.ticket && i.kind === "plan");
      return {
        kind: "you",
        ask: "plan",
        question: plan ? plan.body.trim() : reason,
        checks: [],
        choices: ["Approve the plan", "Ask for changes"],
      };
    }
    case "running":
      return { kind: "running", report: reason, at: s.at };
    case "ready":
      return { kind: "ready", reason, pr };
    case "merged":
      return { kind: "merged", reason, pr };
  }
}

const field = (e: ProtocolEvent, key: string): unknown =>
  e.payload !== null && typeof e.payload === "object" && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)[key]
    : undefined;
const str = (e: ProtocolEvent, key: string) => {
  const v = field(e, key);
  return typeof v === "string" ? v : "";
};

const PHASE_WORD: Record<string, string> = {
  planning: "Planning",
  "awaiting-approval": "Plan posted",
  implementing: "Implementing",
  shipping: "Shipping",
  blocked: "Blocked",
  "ready-to-merge": "Handed back",
  "awaiting-validation": "Waiting for validation",
  released: "Released",
  merged: "Merged",
};

const INBOX_WORD: Record<string, string> = {
  question: "Asked the coordinator",
  plan: "Plan posted",
  "hand-back": "Handed back",
  "owner-request": "Asked you",
  launch: "Launch requested",
};

const FORGE_WORD: Record<string, string> = {
  "pull-request.opened": "opened",
  "pull-request.head-moved": "new commits",
  "pull-request.checks-green": "checks green",
  "pull-request.checks-red": "checks red",
  "pull-request.review-changed": "review changed",
  "pull-request.closed": "closed",
  "pull-request.merged": "merged",
};

/**
 * The session's reports and events, newest first. Answers, decisions and the
 * merge queue's later steps name only their item: they follow the ticket's
 * own inbox items, validations and queue entries. Heartbeats and the
 * forge's unchanged readings are left out.
 */
function entries(own: readonly ProtocolEvent[]): Entry[] {
  const out: Entry[] = [];
  const add = (e: ProtocolEvent, title: string, body = "") => out.push({ seq: e.seq, at: e.at, title, body });
  const queued = new Map<string, number>();
  // The forge's last reading of each pull request: a new line only when its state or checks moved.
  const seen = new Map<number, string>();
  for (const e of own) {
    const pr = field(e, "pr");
    switch (e.kind) {
      case "session.claimed":
        add(e, `Claimed on ${str(e, "runtime") || "a runtime"}`);
        break;
      case "session.reported":
      case "ticket.report-posted":
        add(
          e,
          PHASE_WORD[str(e, "phase")] ?? str(e, "phase"),
          str(e, e.kind === "session.reported" ? "reason" : "body"),
        );
        break;
      case "ticket.phase-changed":
        add(e, `Phase ${PHASE_WORD[str(e, "from")] ?? "none"} → ${PHASE_WORD[str(e, "to")] ?? "none"}`);
        break;
      case "session.released":
        add(e, "Released", str(e, "reason"));
        break;
      case "inbox.opened":
        add(e, INBOX_WORD[str(e, "kind")] ?? "Inbox", str(e, "body"));
        break;
      case "inbox.answered":
        add(e, "Answered", str(e, "answer"));
        break;
      case "validation.opened":
        add(e, "Validation asked", str(e, "question"));
        break;
      case "validation.decided":
        add(e, str(e, "decision") === "approved" ? "Validation approved" : "Changes requested", str(e, "note"));
        break;
      case "merge.queued":
        if (typeof pr === "number") queued.set(str(e, "id"), pr);
        add(e, `#${pr} queued to merge`);
        break;
      case "merge.started":
        add(e, `Merging #${queued.get(str(e, "id")) ?? ""}`.trim());
        break;
      case "merge.refused":
        add(e, "Merge refused", str(e, "reason"));
        break;
      case "merge.canceled":
        add(e, "Merge canceled", str(e, "reason"));
        break;
      case "merge.confirmed":
        add(e, `#${pr} merged`);
        break;
      case "pull-request.seen": {
        const number = field(e, "number");
        const now = `${str(e, "state")} ${str(e, "ci")} ${field(e, "conflicting")}`;
        if (typeof number !== "number" || seen.get(number) === now) break;
        const before = seen.get(number);
        seen.set(number, now);
        const ci = str(e, "ci") as FoldedPullRequest["ci"];
        const words = [
          before === undefined ? "seen" : "",
          str(e, "state") !== "open" ? str(e, "state") : "",
          CHECKS_WORD[ci] ?? "",
          field(e, "conflicting") === true ? "conflicts with main" : "",
        ].filter(Boolean);
        add(e, `#${number} ${words.join(", ")}`);
        break;
      }
      default:
        if (FORGE_WORD[e.kind]) add(e, `#${field(e, "number")} ${FORGE_WORD[e.kind]}`, str(e, "title"));
    }
  }
  return out.reverse();
}

/** The ticket's events, then those that only name one of its items, in log order. */
export function sessionEvents(events: readonly ProtocolEvent[], ticket: string): ProtocolEvent[] {
  const items = new Set<string>();
  const out: ProtocolEvent[] = [];
  for (const e of events) {
    if (field(e, "ticket") === ticket) {
      out.push(e);
      const id = str(e, "id");
      if (id && /^(inbox\.opened|validation\.opened|merge\.queued)$/.test(e.kind)) items.add(id);
    } else if (/^(inbox\.answered|validation\.decided|merge\.(started|refused|canceled))$/.test(e.kind)) {
      if (items.has(str(e, "id"))) out.push(e);
    }
  }
  return out;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A time on the page: the hour on the viewer's day, else the date and the hour. */
export function stamp(at: string, now: number, zone: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const today = dayIn(time, zone) === dayIn(now, zone);
  const key = `${zone} ${today}`;
  let f = formats.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = today
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    try {
      f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone });
    } catch {
      f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    }
    formats.set(key, f);
  }
  return f.format(time);
}
