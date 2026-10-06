// What happened on one ticket, newest first: the activity an agent's page
// shows (THE-869). Pure: the dashboard reads the ticket's Linear comments from
// the project's last reading, its live events, its inbox items and its
// launches from the app's database, and renders the result as is.
//
// A worker's report is recorded twice, as a live event and as a Linear status
// comment; a claim too. Each shows once: the live one wins, completed by the
// comment's facts (the branch, the profile).
import type { LatestEvent, StoredInboxItem } from "./live.ts";
import { REQUEST_KINDS, type RequestKind } from "./request-kinds.ts";
import type { AgentPhase, Comment } from "./types.ts";

export const ACTIVITY_KINDS = [
  "launch",
  "claim",
  "branch",
  "phase",
  "report",
  "question",
  "plan",
  "answer",
  "hand-back",
  "note",
  "request",
  "pr",
  "release",
  "merge",
  "comment",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
  kind: ActivityKind;
  at: string;
  /** Who did it: the person who launched or asked, the worker, the coordinator; null when unknown. */
  author: string | null;
  /** The status line, question, plan, answer, note or comment; null when it has none. */
  text: string | null;
  /** `phase`, `report`, `claim`: the phase it reported. */
  phase: AgentPhase | null;
  /** `claim`: the runtime and its session; `branch`: the branch. */
  runtime: string | null;
  handle: string | null;
  branch: string | null;
  profile: string | null;
  /** `pr`: its number. */
  pr: number | null;
  /** `request`: what the owner asked for. */
  request: RequestKind | null;
  /** `question`, `plan`, `request`: when the coordinator resolved it; null while it is open. */
  resolvedAt: string | null;
}

export interface ActivityInput {
  /** The ticket's Linear comments. */
  comments: Comment[];
  /** The ticket's live events (claim, report, release, merge). */
  events: (LatestEvent & { headSha?: string | null })[];
  /** The ticket's inbox items, open and resolved. */
  inbox: StoredInboxItem[];
  /** The launches the coordinator asked Armada for (`armada brief`), and who asked. */
  launches: { at: string; by: string }[];
  /** The ticket's pull requests, when GitHub was read. */
  prs: { number: number; createdAt: string | null }[];
}

/** A comment and a live event within this window, saying the same, are one report. */
const SAME_MS = 10 * 60_000;

const blank: Omit<ActivityEntry, "kind" | "at"> = {
  author: null,
  text: null,
  phase: null,
  runtime: null,
  handle: null,
  branch: null,
  profile: null,
  pr: null,
  request: null,
  resolvedAt: null,
};

const entry = (kind: ActivityKind, at: string, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ...blank,
  ...over,
  kind,
  at,
});

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_MS;
const clean = (s: string | null | undefined) => (s ?? "").trim();

const PHASES: readonly string[] = [
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
  "merged",
  "released",
];
const phaseOf = (p: string | null | undefined): AgentPhase | null =>
  p && PHASES.includes(p) ? (p as AgentPhase) : null;

interface Status {
  at: string;
  phase: AgentPhase | null;
  text: string | null;
  author: string | null;
  live: boolean;
}

/** Claims, from live events and claim comments, one per claim. */
function claims(input: ActivityInput): ActivityEntry[] {
  const out: ActivityEntry[] = input.events
    .filter((e) => e.kind === "claim")
    .map((e) => entry("claim", e.at, { runtime: e.runtime, handle: e.handle, phase: phaseOf(e.phase) }));
  for (const c of input.comments) {
    if (!c.claim) continue;
    const same = out.find((e) => near(e.at, c.createdAt) && !e.branch && !e.author);
    const facts = {
      author: c.author,
      runtime: c.claim.runtime,
      handle: c.claim.session,
      branch: c.claim.branch,
      profile: c.claim.profile ?? null,
    };
    if (same)
      Object.assign(same, {
        author: facts.author,
        branch: facts.branch,
        profile: facts.profile,
        runtime: same.runtime ?? facts.runtime,
        handle: same.handle ?? facts.handle,
      });
    else out.push(entry("claim", c.createdAt, { ...facts, phase: "planning" }));
  }
  return out;
}

/** Every report once: the live events, and the status comments no event already says. */
function statuses(input: ActivityInput): Status[] {
  const live: Status[] = input.events
    .filter((e) => e.kind === "report")
    .map((e) => ({ at: e.at, phase: phaseOf(e.phase), text: clean(e.message) || null, author: null, live: true }));
  const out = [...live];
  for (const c of input.comments) {
    if (!c.status || c.claim) continue;
    const text = clean(c.status.summary) || null;
    const twin = live.find(
      (s) => near(s.at, c.createdAt) && s.phase === c.status?.phase && (s.text === null || s.text === text),
    );
    if (twin) {
      twin.author ??= c.author;
      twin.text ??= text;
      continue;
    }
    out.push({ at: c.createdAt, phase: c.status.phase, text, author: c.author, live: false });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The ticket's activity, newest first. */
export function agentActivity(input: ActivityInput): ActivityEntry[] {
  const out: ActivityEntry[] = [];

  for (const l of input.launches) out.push(entry("launch", l.at, { author: l.by }));

  const claimed = claims(input);
  for (const c of claimed) {
    out.push(c);
    if (c.branch) out.push(entry("branch", c.at, { branch: c.branch, author: c.author }));
  }

  // A report that enters a new phase is a phase change; the claim starts in planning.
  const firstClaim = [...claimed].sort((a, b) => a.at.localeCompare(b.at))[0];
  let phase: AgentPhase | null = firstClaim ? "planning" : null;
  for (const s of statuses(input)) {
    const changed = s.phase !== null && s.phase !== phase;
    out.push(entry(changed ? "phase" : "report", s.at, { phase: s.phase, text: s.text, author: s.author }));
    if (s.phase) phase = s.phase;
  }

  for (const e of input.events) {
    if (e.kind === "release") out.push(entry("release", e.at, { text: clean(e.message) || null }));
    if (e.kind === "merge") out.push(entry("merge", e.at, { text: clean(e.message) || null }));
  }

  for (const c of input.comments)
    if (!c.status && !c.claim && clean(c.excerpt))
      out.push(entry("comment", c.createdAt, { author: c.author, text: c.excerpt }));

  for (const i of input.inbox) {
    const base = { author: i.author, text: i.body, resolvedAt: i.resolvedAt };
    if (i.kind === "question" || i.kind === "plan") {
      out.push(entry(i.kind, i.createdAt, base));
      if (i.resolvedAt) out.push(entry("answer", i.resolvedAt, { text: clean(i.resolution) || null, request: null }));
    } else if (i.kind === "hand-back") out.push(entry("hand-back", i.createdAt, base));
    else if (i.kind === "linear-pending") out.push(entry("request", i.createdAt, base));
    else if (i.kind === "note") out.push(entry("note", i.createdAt, base));
    else if ((REQUEST_KINDS as readonly string[]).includes(i.kind))
      out.push(entry("request", i.createdAt, { ...base, request: i.kind as RequestKind, pr: i.request?.pr ?? null }));
  }

  for (const p of input.prs) if (p.createdAt) out.push(entry("pr", p.createdAt, { pr: p.number }));

  // Newest first; at the same time, in the order things happen (a launch before its claim, a claim before its branch).
  const order = (k: ActivityKind) => ACTIVITY_KINDS.indexOf(k);
  return out.sort((a, b) => b.at.localeCompare(a.at) || order(b.kind) - order(a.kind));
}
