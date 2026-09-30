// Fleet derivations: tickets in flight (one lane per working agent), the
// frontier of tickets ready to start, and pull requests waiting. Pure functions
// over the model; tolerant of missing forge data and missing status lines.
import { criticalIds, isClosed, isDone, isNotStarted, isStarted, type Model } from "./model.ts";
import type { AgentClaim, AgentPhase, Comment, Issue, PullRequest } from "./types.ts";

const MIN = 60_000;

/** Phases where the coordinator or a human must act. */
export const NEEDS_HUMAN: AgentPhase[] = ["awaiting-approval", "blocked", "ready-to-merge"];

/** Pipeline order, furthest along first. */
const PHASE_RANK: Record<AgentPhase, number> = {
  merged: 0,
  "ready-to-merge": 1,
  shipping: 2,
  implementing: 3,
  "awaiting-approval": 4,
  planning: 5,
  blocked: 6,
  released: 7,
};

const PLAN_HINT = /\b(plan|objective|assumptions|awaiting (?:plan )?approval)\b/i;

export type LaneFlag =
  | "silent"
  | "ci-failing"
  | "conflict"
  | "double-claim"
  | "started-before-blockers"
  | "no-assignee"
  | "no-phase-label";

export interface Lane {
  issue: Issue;
  spec: string | null;
  phase: AgentPhase;
  /** label = the phase label (source of truth); status-line and inferred are fallbacks. */
  phaseSource: "label" | "status-line" | "inferred";
  runtime: string | null;
  claim: AgentClaim | null;
  agent: string | null;
  /** When the current phase was announced (or the best available proxy). */
  since: string;
  /** Latest sign of life: ticket edit, comment, PR update or start. */
  lastUpdate: string;
  statusLine: { summary: string; at: string; author: string | null; url: string } | null;
  pr: PullRequest | null;
  openBlockers: string[];
  flags: LaneFlag[];
}

export function commentsFor(comments: Comment[], id: string): Comment[] {
  return comments.filter((c) => c.issueId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Linear comment permalink (anchor = first 8 characters of the comment id). */
export function commentUrl(issue: Issue, c: Comment): string {
  return `${issue.url}#comment-${c.id.slice(0, 8)}`;
}

/** The PR to show for a ticket: the newest open one, else the newest. */
export function primaryPr(issue: Issue): PullRequest | null {
  const byNewest = [...issue.prs].sort((a, b) => b.number - a.number);
  return byNewest.find((p) => p.state === "open") ?? byNewest[0] ?? null;
}

/** Claims since the last release; the oldest claim wins. */
export function activeClaims(comments: Comment[]): AgentClaim[] {
  const asc = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let claims: AgentClaim[] = [];
  for (const c of asc) {
    if (c.status?.phase === "released") claims = [];
    if (c.claim) claims.push(c.claim);
  }
  return claims;
}

const latest = (...xs: (string | null | undefined)[]) =>
  xs.filter((x): x is string => !!x).reduce((a, b) => (b > a ? b : a), "");

function inferPhase(pr: PullRequest | null, comments: Comment[]): AgentPhase {
  if (pr?.state === "open")
    return pr.ci === "success" && pr.mergeable !== "CONFLICTING" ? "ready-to-merge" : "shipping";
  if (comments.some((c) => PLAN_HINT.test(c.excerpt.slice(0, 120)))) return "awaiting-approval";
  return "planning";
}

export interface LaneOptions {
  now: number;
  silentAfterMinutes: number;
}

export function buildLane(m: Model, allComments: Comment[], issue: Issue, opts: LaneOptions): Lane {
  const comments = commentsFor(allComments, issue.id);
  const withStatus = comments.find((c) => c.status && c.status.phase !== "released");
  const pr = primaryPr(issue);
  const claims = activeClaims(comments);

  let phase: AgentPhase;
  let phaseSource: Lane["phaseSource"];
  if (issue.agentPhase) {
    phase = issue.agentPhase;
    phaseSource = "label";
  } else if (withStatus?.status) {
    phase = withStatus.status.phase;
    phaseSource = "status-line";
  } else {
    phase = inferPhase(pr, comments);
    phaseSource = "inferred";
  }
  // A merged PR ends the work only if the agent was shipping it; a label that
  // says the agent went back to planning or implementing still wins.
  const shippingPhase = phase === "shipping" || phase === "ready-to-merge";
  if (pr?.state === "merged" && !isDone(issue) && (shippingPhase || phaseSource !== "label")) phase = "merged";

  const announcing = comments.find((c) => c.status?.phase === phase);
  const since =
    announcing?.createdAt ??
    (phase === "shipping" || phase === "ready-to-merge" ? pr?.createdAt : undefined) ??
    claims[0]?.at ??
    issue.startedAt ??
    issue.updatedAt;
  const lastUpdate = latest(issue.updatedAt, comments[0]?.createdAt, pr?.updatedAt, issue.startedAt);
  const openBlockers = m.openBlockersOf(issue);
  const agent = issue.delegate ?? issue.assignee;

  const flags: LaneFlag[] = [];
  const waitingOnHuman = NEEDS_HUMAN.includes(phase) || phase === "merged";
  if (!waitingOnHuman && opts.now - Date.parse(lastUpdate) > opts.silentAfterMinutes * MIN) flags.push("silent");
  if (pr?.state === "open" && pr.ci === "failure") flags.push("ci-failing");
  if (pr?.state === "open" && pr.mergeable === "CONFLICTING") flags.push("conflict");
  const runtimes = new Set(claims.map((c) => c.runtime).filter(Boolean));
  const claimRuntime = claims[0]?.runtime;
  if (
    claims.length > 1 ||
    runtimes.size > 1 ||
    (issue.agentRuntime && claimRuntime && claimRuntime !== issue.agentRuntime)
  )
    flags.push("double-claim");
  if (openBlockers.length) flags.push("started-before-blockers");
  if (!agent) flags.push("no-assignee");
  if (!issue.agentPhase) flags.push("no-phase-label");

  const spec = m.specOf(issue.id);
  return {
    issue,
    spec: spec ? `Spec ${spec.ordinal}` : null,
    phase,
    phaseSource,
    runtime: issue.agentRuntime ?? claimRuntime ?? null,
    claim: claims[0] ?? null,
    agent,
    since,
    lastUpdate,
    statusLine: withStatus?.status
      ? {
          summary: withStatus.status.summary,
          at: withStatus.createdAt,
          author: withStatus.author,
          url: commentUrl(issue, withStatus),
        }
      : null,
    pr,
    openBlockers,
    flags,
  };
}

/**
 * Tickets in flight: open leaves that carry an agent phase label, plus started
 * leaves without one (shown with an inferred phase and flagged).
 */
export function inFlight(m: Model, comments: Comment[], opts: LaneOptions): Lane[] {
  return m.program
    .filter((i) => m.isLeaf(i) && !isClosed(i) && (i.agentPhase || isStarted(i)))
    .map((i) => buildLane(m, comments, i, opts))
    .sort(
      (a, b) =>
        PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.issue.id.localeCompare(b.issue.id, "en", { numeric: true }),
    );
}

export interface Candidate {
  issue: Issue;
  spec: string | null;
  /** Carries the ready label and is out of triage. */
  readyForAgent: boolean;
  onCriticalPath: boolean;
  /** Every open ticket that transitively waits on this one. */
  unlocksAll: string[];
  /** Tickets whose last open blocker is this one. */
  unlocksNow: string[];
  score: number;
}

/**
 * The frontier: leaves not started, not held by an agent, with every
 * blocked-by ticket closed and no open pull request. Ranked: ready label
 * first, then critical path, then how much work each one unlocks.
 */
export function frontier(m: Model, readyLabel: string): Candidate[] {
  const dependents = new Map<string, Issue[]>();
  for (const i of m.program) for (const b of i.blockedBy) dependents.set(b.id, [...(dependents.get(b.id) ?? []), i]);
  const transitive = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of dependents.get(id) ?? [])
      if (!seen.has(d.id) && !isClosed(d)) {
        seen.add(d.id);
        transitive(d.id, seen);
      }
    return seen;
  };
  const critical = criticalIds(m);
  return m.program
    .filter(
      (i) =>
        m.isLeaf(i) &&
        isNotStarted(i) &&
        !i.agentPhase &&
        m.openBlockersOf(i).length === 0 &&
        !i.prs.some((p) => p.state === "open"),
    )
    .map((issue) => {
      const spec = m.specOf(issue.id);
      const unlocksAll = [...transitive(issue.id)];
      const unlocksNow = (dependents.get(issue.id) ?? [])
        .filter((d) => !isClosed(d) && m.openBlockersOf(d).every((b) => b === issue.id))
        .map((d) => d.id);
      const readyForAgent = issue.labels.includes(readyLabel) && issue.statusType !== "triage";
      const onCriticalPath = critical.has(issue.id);
      const score =
        (readyForAgent ? 1000 : 0) +
        (onCriticalPath ? 300 : 0) +
        unlocksAll.length * 20 +
        unlocksNow.length * 10 -
        (spec?.ordinal ?? 99);
      return {
        issue,
        spec: spec ? `Spec ${spec.ordinal}` : null,
        readyForAgent,
        onCriticalPath,
        unlocksAll,
        unlocksNow,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || a.issue.id.localeCompare(b.issue.id, "en", { numeric: true }));
}

export interface WaitingPr {
  pr: PullRequest;
  ticket: Issue | null;
}

/** Open pull requests of the repository, each with the program ticket it belongs to, if any. */
export function waitingPullRequests(m: Model, prs: PullRequest[]): WaitingPr[] {
  const ticketOf = new Map<string, Issue>();
  for (const i of m.program) for (const p of i.prs) ticketOf.set(p.url, i);
  return prs
    .filter((p) => p.state === "open")
    .map((pr) => ({ pr, ticket: ticketOf.get(pr.url) ?? null }))
    .sort((a, b) => a.pr.number - b.pr.number);
}
