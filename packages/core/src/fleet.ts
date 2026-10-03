// Fleet derivations: tickets in flight (one lane per working agent), the
// frontier of tickets ready to start, and pull requests waiting. Pure functions
// over the model; tolerant of missing forge data and missing status lines.
import type { RuntimeObservation } from "./live.ts";
import { criticalIds, isClosed, isDone, isNotStarted, isStarted, type Model } from "./model.ts";
import { type AgentClaim, type AgentPhase, type Comment, type Issue, LABEL_PHASES, type PullRequest } from "./types.ts";

const MIN = 60_000;

/** Phases where the coordinator or a human must act. */
export const NEEDS_HUMAN: AgentPhase[] = ["awaiting-approval", "awaiting-validation", "blocked", "ready-to-merge"];

/** Pipeline order, furthest along first. */
const PHASE_RANK: Record<AgentPhase, number> = {
  merged: 0,
  "ready-to-merge": 1,
  shipping: 2,
  implementing: 3,
  "awaiting-validation": 4,
  "awaiting-approval": 5,
  planning: 6,
  blocked: 7,
  released: 8,
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
  /**
   * label = the phase label (source of truth); status-line and inferred are
   * fallbacks; live = a live report newer than the tracker read.
   */
  phaseSource: "label" | "status-line" | "inferred" | "live";
  runtime: string | null;
  /** The worker's runtime session: the live runtime handle, else the claim's session. */
  handle: string | null;
  claim: AgentClaim | null;
  agent: string | null;
  /** When the current phase was announced (or the best available proxy). */
  since: string;
  /** Latest sign of life: ticket edit, comment, PR update or start. */
  lastUpdate: string;
  /** Latest report by the worker: live event, `Agent status:` comment or claim. Null when it never reported. */
  lastReport: string | null;
  lastHeartbeat?: string | null;
  /** `plan`: the status comment carries the worker's plan, at `url`. */
  statusLine: { summary: string; at: string; author: string | null; url: string; plan: boolean } | null;
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

/** Newest worker liveness; unrelated ticket updates are a fallback only before its first report or ping. */
export function workerLivenessAt(worker: Pick<Lane, "lastHeartbeat" | "lastReport" | "lastUpdate">): string {
  return latest(worker.lastHeartbeat, worker.lastReport) || worker.lastUpdate;
}

function inferPhase(pr: PullRequest | null, comments: Comment[]): AgentPhase {
  if (pr?.state === "open")
    return pr.ci === "success" && pr.mergeable !== "CONFLICTING" ? "ready-to-merge" : "shipping";
  if (comments.some((c) => PLAN_HINT.test(c.excerpt.slice(0, 120)))) return "awaiting-approval";
  return "planning";
}

/** A worker event read from the fleet's live data (claim, report or release). */
export interface LiveEvent {
  kind: string;
  phase: string | null;
  message: string | null;
  runtime?: string | null;
  handle?: string | null;
  at: string;
}

export interface LaneOptions {
  now: number;
  silentAfterMinutes: number;
  /** Newest live event per ticket id, when the live data was read. */
  lastEvents?: Record<string, string>;
  heartbeats?: Record<string, string>;
  /**
   * Live news from the fleet's live data. The tracker is read less often, so an
   * event newer than `after` (when the tracker read started) says more than
   * the tracker does: its phase wins, and a claim puts the ticket in flight.
   */
  live?: {
    after: string;
    /** Newest event per ticket id. */
    events: Record<string, LiveEvent>;
    /** Open runtime handle per ticket id. */
    handles?: Record<
      string,
      {
        runtime: string;
        handle: string;
        profile?: string | null;
        lastHeartbeatAt?: string | null;
        runtimeState?: RuntimeObservation | null;
        claimedAt?: string;
        releasedAt?: string | null;
      }
    >;
  };
}

/** Event kinds after which no worker holds the ticket. */
const ENDS_WORK = ["release", "merge"];

const livePhase = (e: LiveEvent): AgentPhase | null =>
  e.kind === "release" ? "released" : (LABEL_PHASES.find((p) => p === e.phase) ?? null);

/** The live event of a ticket that happened after the tracker read, if any. */
export function freshEvent(issueId: string, opts: Pick<LaneOptions, "live">): LiveEvent | null {
  const e = opts.live?.events[issueId];
  return e && opts.live && e.at > opts.live.after ? e : null;
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
  const fresh = freshEvent(issue.id, opts);
  const freshPhase = fresh ? livePhase(fresh) : null;
  const trackerPhase = phase;
  if (freshPhase && freshPhase !== "released") {
    phase = freshPhase;
    phaseSource = "live";
  }
  // A merged PR ends the work only if the agent was shipping it; a label that
  // says the agent went back to planning or implementing still wins.
  const shippingPhase = phase === "shipping" || phase === "ready-to-merge";
  if (
    pr?.state === "merged" &&
    !isDone(issue) &&
    (shippingPhase || phaseSource === "status-line" || phaseSource === "inferred")
  )
    phase = "merged";

  // The phase started with the oldest status line of the latest run announcing it.
  let announcing: Comment | undefined;
  for (const c of comments) {
    if (!c.status || c.status.phase === "released") continue;
    if (c.status.phase !== phase) break;
    announcing = c;
  }
  const since =
    (fresh && phaseSource === "live" && phase !== trackerPhase ? fresh.at : undefined) ??
    announcing?.createdAt ??
    // A live phase no status comment of the snapshot announces started with that event.
    (fresh && phaseSource === "live" ? fresh.at : undefined) ??
    (phase === "shipping" || phase === "ready-to-merge" ? pr?.createdAt : undefined) ??
    claims[0]?.at ??
    issue.startedAt ??
    issue.updatedAt;
  const lastUpdate = latest(issue.updatedAt, comments[0]?.createdAt, pr?.updatedAt, issue.startedAt, fresh?.at);
  const lastReport =
    latest(
      comments.find((c) => c.status || c.claim)?.createdAt,
      claims.at(-1)?.at,
      opts.lastEvents?.[issue.id],
      fresh?.at,
    ) || null;
  const openBlockers = m.openBlockersOf(issue);
  const agent = issue.delegate ?? issue.assignee;

  const flags: LaneFlag[] = [];
  const waitingOnHuman = NEEDS_HUMAN.includes(phase) || phase === "merged";
  // A resumed report is fresh liveness even if the previous turn's heartbeat stopped.
  // Ticket edits and ordinary comments count only when the worker has never reported or pinged.
  const lastHeartbeat = opts.heartbeats?.[issue.id] ?? opts.live?.handles?.[issue.id]?.lastHeartbeatAt ?? null;
  const alive = workerLivenessAt({ lastHeartbeat, lastReport, lastUpdate });
  if (!waitingOnHuman && opts.now - Date.parse(alive) > opts.silentAfterMinutes * MIN) flags.push("silent");
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
  // A claim newer than the tracker read has not reached the snapshot yet.
  if (!agent && phaseSource !== "live") flags.push("no-assignee");
  if (!issue.agentPhase && phaseSource !== "live") flags.push("no-phase-label");

  const spec = m.specOf(issue.id);
  return {
    issue,
    spec: spec ? `Spec ${spec.ordinal}` : null,
    phase,
    phaseSource,
    runtime: issue.agentRuntime ?? claimRuntime ?? fresh?.runtime ?? opts.live?.handles?.[issue.id]?.runtime ?? null,
    handle: opts.live?.handles?.[issue.id]?.handle ?? claims[0]?.session ?? fresh?.handle ?? null,
    claim: claims[0] ?? null,
    agent,
    since,
    lastUpdate,
    lastReport,
    lastHeartbeat,
    statusLine:
      fresh?.message && phaseSource === "live"
        ? { summary: fresh.message, at: fresh.at, author: null, url: issue.url, plan: false }
        : withStatus?.status
          ? {
              summary: withStatus.status.summary,
              at: withStatus.createdAt,
              author: withStatus.author,
              url: commentUrl(issue, withStatus),
              plan: !!withStatus.status.plan,
            }
          : null,
    pr,
    openBlockers,
    flags,
  };
}

/**
 * Tickets in flight: open leaves that carry an agent phase label, plus started
 * leaves without one (shown with an inferred phase and flagged), and leaves
 * with an open persisted runtime handle. A live event
 * newer than the tracker read decides on its own: a release or a merge takes
 * the ticket out, any other event puts it in.
 */
export function inFlight(m: Model, comments: Comment[], opts: LaneOptions): Lane[] {
  const held = (i: Issue) => {
    const fresh = freshEvent(i.id, opts);
    const handle = opts.live?.handles?.[i.id];
    const open = !!handle && !handle.releasedAt;
    if (fresh) {
      if (!ENDS_WORK.includes(fresh.kind)) return true;
      // A replacement claim survives an older release or merge in the reading.
      return open && !!handle.claimedAt && handle.claimedAt > fresh.at;
    }
    return open || !!i.agentPhase || isStarted(i);
  };
  return m.program
    .filter((i) => m.isLeaf(i) && !isClosed(i) && held(i))
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

/** The label names the frontier reads, from `[tracker]` in `armada.toml`. */
export interface FrontierLabels {
  /** `ready_label`: the ticket is specified enough for an agent to take. */
  ready: string;
  /** `parked_label`: the ticket waits on purpose, so it is no work to start. */
  parked: string;
}

/**
 * The frontier: leaves not started, not held by an agent, not parked, with
 * every blocked-by ticket closed and no open pull request. Ranked: ready label
 * first, then critical path, then how much work each one unlocks.
 */
export function frontier(m: Model, labels: FrontierLabels): Candidate[] {
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
        !i.labels.includes(labels.parked) &&
        m.openBlockersOf(i).length === 0 &&
        !i.prs.some((p) => p.state === "open"),
    )
    .map((issue) => {
      const spec = m.specOf(issue.id);
      const unlocksAll = [...transitive(issue.id)];
      const unlocksNow = (dependents.get(issue.id) ?? [])
        .filter((d) => !isClosed(d) && m.openBlockersOf(d).every((b) => b === issue.id))
        .map((d) => d.id);
      const readyForAgent = issue.labels.includes(labels.ready) && issue.statusType !== "triage";
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
