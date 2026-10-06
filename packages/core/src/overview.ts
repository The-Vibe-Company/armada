// The fleet of every registered project in one reading: the rows of the
// dashboard's Fleet view (one per ticket in flight, across projects) and the
// list of what waits for the owner. Pure: the dashboard reads the sources,
// calls `buildOverview` and renders the result as is.
import { newerRelease } from "./armada-api.ts";
import type { Attachment } from "./attachments.ts";
import { CONFIG_DEFAULTS, type ConductorProfile } from "./config.ts";
import { workerLivenessAt } from "./fleet.ts";
import type { JobSummary } from "./jobs.ts";
import type { CoordinatorPresence, InboxItem, InboxReadEvent, SessionRecord } from "./live.ts";
import { REQUEST_KINDS } from "./request-kinds.ts";
import type { FrontierTicket, InFlightTicket, MergedTicket, StatusReport } from "./status.ts";
import {
  type CoordinatorTrack,
  coordinatorTrack,
  historyByTicket,
  type SessionTimeline,
  sessionTimeline,
  type TimelineHistory,
} from "./timeline.ts";
import type { AgentPhase } from "./types.ts";
import type { Validation } from "./validations.ts";

export const OVERVIEW_SCHEMA_VERSION = 3;

/** The six steps of the phase pipeline, in order. */
export const PIPELINE_STEPS = ["plan", "approval", "implement", "pr", "ci", "merge"] as const;

export interface Pipeline {
  /** Index in PIPELINE_STEPS of the step the ticket is at. */
  step: number;
  /** ok = moving; wait = a human or the coordinator must act; fail = red CI, conflict or blocked. */
  state: "ok" | "wait" | "fail";
}

export function pipeline(t: Pick<InFlightTicket, "phase" | "pr">): Pipeline {
  const pr = t.pr;
  const checked = !!pr?.ci && pr.ci !== "none";
  const at: Record<AgentPhase, Pipeline> = {
    planning: { step: 0, state: "ok" },
    "awaiting-approval": { step: 1, state: "wait" },
    // The owner checks a design or a change before the work goes on.
    "awaiting-validation": { step: pr ? 3 : 1, state: "wait" },
    implementing: { step: 2, state: "ok" },
    shipping: { step: checked ? 4 : 3, state: pr?.ci === "failure" ? "fail" : "ok" },
    "ready-to-merge": { step: 5, state: "wait" },
    merged: { step: 5, state: "ok" },
    blocked: { step: pr ? 3 : 1, state: "fail" },
    released: { step: 0, state: "ok" },
  };
  const p = at[t.phase];
  return pr?.mergeable === "CONFLICTING" ? { ...p, state: "fail" } : p;
}

/** A ticket's flow on the overview's board (THE-988), left to right. */
export const FLOW_STEPS = ["plan", "implementing", "review", "ci", "merged"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** Where a working phase sits in the flow; a waiting phase sits in the step it left. */
const PHASE_STEP: Partial<Record<AgentPhase, FlowStep>> = {
  planning: "plan",
  "awaiting-approval": "plan",
  released: "plan",
  implementing: "implementing",
  "ready-to-merge": "ci",
  merged: "merged",
};

/**
 * A session's step in the flow: its phase's, shipping by its stage (review
 * until the pull request has checks when no stage was reported); blocked or
 * awaiting a validation, the step of its last working phase (`earlier`, its
 * timeline's phases oldest first), else where its pull request is, else plan.
 */
export function flowStep(
  t: Pick<InFlightTicket, "phase" | "shippingStage" | "pr">,
  earlier: readonly AgentPhase[] = [],
): FlowStep {
  const checked = !!t.pr?.ci && t.pr.ci !== "none";
  const shipping = t.shippingStage ?? (checked ? "ci" : "review");
  const of = (phase: AgentPhase) => (phase === "shipping" ? shipping : PHASE_STEP[phase]);
  const own = of(t.phase);
  if (own) return own;
  for (const phase of [...earlier].reverse()) {
    const step = of(phase);
    if (step && phase !== "released") return step;
  }
  return t.pr ? shipping : "plan";
}

/** What waits for the owner, most urgent kind first. */
export const WAITING_KINDS = ["question", "blocked", "approval", "hand-back", "not-started", "silent"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface WaitingItem {
  kind: WaitingKind;
  project: string;
  ticket: string | null;
  title: string | null;
  url: string | null;
  /** The question, full plan, hand-back note, the worker's last status, or why a launched worker shows as not started. */
  detail: string | null;
  author: string | null;
  /** Since when it waits. */
  since: string;
  /** For a question or plan: its inbox item id, which the dashboard answers. */
  item: number | null;
  /** For a question or plan: the owner's answer waiting for the coordinator to deliver it. */
  answer: PendingAnswer | null;
  /**
   * Set when an item has been open in the coordinator's inbox for longer than
   * `policy.coordinator_minutes`: since when it waits for the coordinator.
   */
  coordinatorSince: string | null;
}

/** An answer sent from the dashboard that the coordinator has not delivered yet. */
export interface PendingAnswer {
  id: number;
  body: string;
  author: string | null;
  at: string;
}

/** A ticket ready to start, with what a launch from the dashboard needs. */
export interface ReadyTicket extends FrontierTicket {
  project: string;
  /** A launch asked from the dashboard that no worker has claimed yet. */
  launch: { id: number; author: string | null; at: string; profile: string | null } | null;
}

export interface ProfileSummary {
  name: string;
  agent: string;
  model: string;
  effort: string;
}

export interface FleetRow extends InFlightTicket {
  session: SessionRecord | null;
  project: string;
  /** The oldest open question of this ticket in the coordinator's inbox. */
  question: { id: number; body: string; at: string; author: string | null; answer: PendingAnswer | null } | null;
  pipeline: Pipeline;
  /** Its column on the overview's board. */
  step: FlowStep;
  /** Set when the row is in the waiting list. */
  waiting: WaitingKind | null;
}

/**
 * The overview's live timeline (THE-868, THE-880): each row's last
 * `TIMELINE_HOURS` and each coordinator's inbox reads. It weighs more than
 * the rest of the overview (a day of reports per session), so the dashboard
 * serves it on its own route, read only while the timeline is on screen.
 */
export interface FleetTimeline {
  rows: { project: string; id: string; timeline: SessionTimeline }[];
  coordinators: { project: string; inboxTrack: CoordinatorTrack }[];
}

/** A long job as the dashboard shows it: no runner reference or starter, which no screen draws. */
export type ShownJob = Omit<JobSummary, "ref" | "startedBy">;

export type CoordinatorState = "active" | "idle" | "unknown";

/**
 * One named coordinator of a project (THE-1109, THE-1112): what it last told
 * Armada, whether it is at work by the project's silence threshold, and the
 * tickets in flight it owns.
 */
export interface ProjectCoordinator extends Partial<Omit<CoordinatorPresence, "seenAt">> {
  name: string;
  state: CoordinatorState;
  seenAt: string | null;
  tickets: string[];
  /** A newer CLI is released than the one it ran last. */
  updateAvailable: boolean;
}

export interface ProjectOverview {
  /** Default-branch CI, carried from the stored forge snapshot. */
  main?: StatusReport["main"];
  owner: string | null;
  progress: { done: number; total: number } | null;
  health: ProjectHealth | null;
  pullRequests: StatusReport["pullRequests"];
  /** Its last tickets merged, newest first (THE-988). */
  merged: MergedTicket[];
  /** Its long jobs (THE-1128): the open ones and those of its tickets ended lately, as the store gives them. */
  jobs: ShownJob[];
  requests: InboxItem[];
  slug: string;
  name: string;
  repository: string;
  programRoot: StatusReport["programRoot"] | null;
  /**
   * Active when a coordinator command ran within the project's silence threshold.
   * `cliVersion`: the CLI it ran at that read (null when unknown);
   * `updateAvailable`: a newer CLI is released than the one it runs.
   */
  coordinator: {
    state: CoordinatorState;
    seenAt: string | null;
    cliVersion: string | null;
    updateAvailable: boolean;
  } & Partial<Omit<CoordinatorPresence, "seenAt">>;
  /**
   * Every coordinator of the project by name, and the owner of a ticket in
   * flight no role lists. Absent from older readings (the landing's).
   */
  coordinators?: ProjectCoordinator[];
  inFlight: number;
  waiting: number;
  sources: StatusReport["sources"] | null;
  /** The Conductor profiles a launch can use, from armada.toml. */
  profiles: ProfileSummary[];
  /** Set when the project could not be read at all. */
  error: string | null;
  /** Its first reading of Linear and GitHub is under way: it shows on a next poll. */
  reading: boolean;
  warnings: string[];
}

/**
 * What the owner validates (THE-885), as the dashboard shows it: the
 * validation, its ticket's title, and the attachments to look at (those it
 * names, else its ticket's).
 */
export interface OwnerValidation extends Validation {
  title: string | null;
  url: string | null;
  gallery: Attachment[];
  /** Additional ticket images omitted from the automatic sample. */
  galleryMore?: number;
}

/** One project as the dashboard read it. */
export interface ProjectReading {
  owner?: string | null;
  slug: string;
  name: string;
  repository: string;
  report: StatusReport | null;
  error: string | null;
  /** No reading yet, and one is under way. */
  reading?: boolean;
  warnings?: string[];
  /** Null when the live data was not read. */
  live: {
    inbox: InboxItem[];
    coordinatorSeenAt: string | null;
    coordinatorCliVersion?: string | null;
    coordinator?: CoordinatorPresence | null;
    /** Every named coordinator of the project (THE-1109). */
    coordinators?: CoordinatorPresence[];
    inboxReads?: InboxReadEvent[];
    sessions?: SessionRecord[];
    /** Open validations and those decided lately, with their gallery and their ticket's title when known. */
    validations?: OwnerValidation[];
  } | null;
  /** `[conductor.profiles]` of its armada.toml. */
  profiles?: Record<string, ConductorProfile>;
  /** The snapshot's comments and Armada's recent events, which each row's timeline is drawn from. */
  history?: TimelineHistory;
}

/**
 * Dashboard contract: projects expose owner, leaf-ticket progress, health, open PR facts,
 * pending requests and coordinator {harness, handle, model, cliVersion, startedAt,
 * seenAt, inboxSeenAt}. `seenAt` is command activity, not an inbox read.
 * `sessions` retains per-launch profile/agent/model/effort, claimedAt, releasedAt and
 * lastReport; each row points to its active session. `timeline` carries each row's history
 * (phases, report times, silences, PR opening over the last 24 h, from the snapshot's status
 * comments and Armada's events; summaries cut short) and each coordinator's inbox reads. Ready tickets carry their labels (the ready label
 * left out) and open PRs their head branch. PR files/totals may be null for
 * legacy snapshots; completeness flags identify capped lists. Missing facts are never inferred.
 */
export interface FleetOverview {
  sessions: SessionRecord[];
  schemaVersion: typeof OVERVIEW_SCHEMA_VERSION;
  generatedAt: string;
  /** The live data: ok, unreachable (the view falls back to Linear and GitHub) or off (not configured). */
  live: { state: "ok" | "unreachable" | "off"; error: string | null };
  projects: ProjectOverview[];
  waiting: WaitingItem[];
  rows: FleetRow[];
  /** Tickets ready to start, per project in frontier order (best first). */
  ready: ReadyTicket[];
  /** What the owner validates: the open ones first (oldest first), then those decided lately (newest first). */
  validations: OwnerValidation[];
  /** Left out of the dashboard's live poll, which serves it on its own route. */
  timeline?: FleetTimeline;
}

const MIN = 60_000;
export type ProjectHealth = "blocked" | "watch" | "on-track";

export function projectHealth(input: {
  tickets: Pick<InFlightTicket, "phase" | "silent">[];
  prs: Pick<PrRefForHealth, "ci" | "mergeability" | "mergeable">[];
  inbox: Pick<InboxItem, "createdAt">[];
  coordinator: CoordinatorState;
  coordinatorMinutes: number;
  now: Date;
}): ProjectHealth {
  const overdue = input.inbox.some(
    (item) => input.now.getTime() - Date.parse(item.createdAt) > input.coordinatorMinutes * MIN,
  );
  if (
    input.tickets.some((ticket) => ticket.phase === "blocked") ||
    input.prs.some(
      (pr) => pr.ci === "failure" || pr.mergeability === "conflicting" || pr.mergeable === "CONFLICTING",
    ) ||
    (input.coordinator !== "active" && overdue)
  )
    return "blocked";
  return overdue || input.tickets.some((ticket) => ticket.silent) ? "watch" : "on-track";
}

type PrRefForHealth = NonNullable<StatusReport["pullRequests"]>[number];
const rank = (k: WaitingKind | null) => (k ? WAITING_KINDS.indexOf(k) : WAITING_KINDS.length);

function laneWaiting(t: InFlightTicket): WaitingKind | null {
  if (t.phase === "blocked") return "blocked";
  if (t.phase === "awaiting-approval") return "approval";
  if (t.phase === "ready-to-merge") return "hand-back";
  if (t.silent) return "silent";
  return null;
}

export function buildOverview(input: {
  projects: ProjectReading[];
  live: FleetOverview["live"];
  now: Date;
  /** The latest CLI released, which each coordinator's is compared with; null when unknown. */
  latestCli?: string | null;
}): FleetOverview {
  const now = input.now.getTime();
  const rows: FleetRow[] = [];
  const waiting: WaitingItem[] = [];
  const projects: ProjectOverview[] = [];
  const timeline: FleetTimeline = { rows: [], coordinators: [] };
  const ready: ReadyTicket[] = [];
  const sessions: SessionRecord[] = [];
  const validations: OwnerValidation[] = [];

  for (const p of input.projects) {
    const tickets = p.report?.inFlight ?? [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const inbox = (p.live?.inbox ?? []).filter((i) => i.recipient === "coordinator");
    sessions.push(...(p.live?.sessions ?? []));
    const questions = new Map<string, InboxItem>();
    for (const q of inbox)
      if (q.kind === "question" && q.ticket && !questions.has(q.ticket)) questions.set(q.ticket, q);
    // Requests the owner made from the dashboard, until the coordinator resolves them.
    const answers = new Map<number, PendingAnswer>();
    const launches = new Map<string, ReadyTicket["launch"]>();
    for (const r of inbox) {
      if (r.kind === "answer-request" && r.request?.question != null && !answers.has(r.request.question))
        answers.set(r.request.question, { id: r.id, body: r.body, author: r.author, at: r.createdAt });
      if (r.kind === "launch-request" && r.ticket && !launches.has(r.ticket))
        launches.set(r.ticket, { id: r.id, author: r.author, at: r.createdAt, profile: r.request?.profile ?? null });
    }

    // The oldest item of each ticket open in the coordinator's inbox for too long: the coordinator is not answering.
    const lateAfter = (p.report?.coordinatorMinutes ?? CONFIG_DEFAULTS.coordinatorMinutes) * MIN;
    const late = new Map<string, string>();
    for (const i of inbox)
      if (i.ticket && now - Date.parse(i.createdAt) > lateAfter) {
        const held = late.get(i.ticket);
        if (!held || i.createdAt < held) late.set(i.ticket, i.createdAt);
      }

    // One waiting item per ticket: its most urgent reason. Project-wide items stay separate.
    const perTicket = new Map<string, WaitingItem>();
    let projectWide = 0;
    const offer = (offered: WaitingItem) => {
      // A ticket waits for the coordinator since its oldest late item; a project-wide item, on its own.
      const own = now - Date.parse(offered.since) > lateAfter ? offered.since : null;
      const item = { ...offered, coordinatorSince: offered.ticket ? (late.get(offered.ticket) ?? null) : own };
      if (!item.ticket) {
        projectWide++;
        waiting.push(item);
        return;
      }
      const held = perTicket.get(item.ticket);
      if (!held || rank(item.kind) < rank(held.kind)) perTicket.set(item.ticket, item);
    };
    const about = (ticket: string | null) => {
      const t = ticket ? byId.get(ticket) : undefined;
      return { title: t?.title ?? null, url: t?.url ?? null };
    };
    for (const item of inbox) {
      if (item.kind !== "question" && item.kind !== "plan" && item.kind !== "hand-back") continue;
      const answerable = item.kind === "question" || item.kind === "plan";
      offer({
        kind: item.kind === "plan" ? "approval" : item.kind,
        project: p.slug,
        ticket: item.ticket,
        ...about(item.ticket),
        detail: item.body,
        author: item.author,
        since: item.createdAt,
        item: answerable ? item.id : null,
        answer: answerable ? (answers.get(item.id) ?? null) : null,
        coordinatorSince: null,
      });
    }
    for (const t of tickets) {
      const kind = laneWaiting(t);
      if (!kind) continue;
      offer({
        kind,
        project: p.slug,
        ticket: t.id,
        title: t.title,
        url: t.statusLine?.url ?? t.url,
        detail: t.statusLine?.summary ?? null,
        author: t.agent,
        since: kind === "silent" ? workerLivenessAt(t) : t.since,
        item: null,
        answer: null,
        coordinatorSince: null,
      });
    }
    // A worker launched that never claimed its ticket waits like a silent one.
    for (const l of p.report?.notStarted ?? [])
      offer({
        kind: "not-started",
        project: p.slug,
        ticket: l.ticket,
        title: l.title,
        url: l.url,
        detail: l.detail,
        author: l.handle,
        since: l.launchedAt,
        item: null,
        answer: null,
        coordinatorSince: null,
      });
    waiting.push(...perTicket.values());

    const history = historyByTicket(p.history);
    const silentAfterMinutes = p.report?.silentAfterMinutes ?? CONFIG_DEFAULTS.silentAfterMinutes;
    for (const t of tickets) {
      const q = questions.get(t.id);
      const tl = sessionTimeline({
        ticket: t,
        history: history.get(t.id) ?? { comments: [], events: [] },
        silentAfterMinutes,
        now: input.now,
      });
      rows.push({
        ...t,
        session: p.live?.sessions?.find((session) => session.ticket === t.id && session.releasedAt === null) ?? null,
        project: p.slug,
        question: q
          ? { id: q.id, body: q.body, at: q.createdAt, author: q.author, answer: answers.get(q.id) ?? null }
          : null,
        pipeline: pipeline(t),
        step: flowStep(
          t,
          tl.phases.map((s) => s.phase),
        ),
        waiting: perTicket.get(t.id)?.kind ?? null,
      });
      timeline.rows.push({ project: p.slug, id: t.id, timeline: tl });
    }

    for (const f of p.report?.frontier ?? []) ready.push({ ...f, project: p.slug, launch: launches.get(f.id) ?? null });

    for (const v of p.live?.validations ?? []) {
      const t = byId.get(v.ticket);
      validations.push({ ...v, title: v.title ?? t?.title ?? null, url: v.url ?? t?.url ?? null });
    }

    const seenAt = p.live?.coordinator?.seenAt ?? p.live?.coordinatorSeenAt ?? null;
    const cliVersion = p.live?.coordinator?.cliVersion ?? p.live?.coordinatorCliVersion ?? null;
    const threshold = (p.report?.silentAfterMinutes ?? 15) * MIN;
    const stateAt = (at: string | null): CoordinatorState =>
      at === null ? "unknown" : now - Date.parse(at) <= threshold ? "active" : "idle";
    const outdated = (version: string | null | undefined) =>
      !!version && newerRelease(version, input.latestCli) !== null;
    const state = stateAt(seenAt);
    const roles = (p.live?.coordinators ?? []).map((r) => ({ ...r, name: r.name ?? "default" }));
    const owners = [...new Set(tickets.flatMap((t) => (t.coordinator ? [t.coordinator] : [])))];
    const coordinators: ProjectCoordinator[] = [
      ...roles,
      ...owners
        .filter((name) => !roles.some((r) => r.name === name))
        .map((name) => ({ name, seenAt: null, cliVersion: null })),
    ]
      .map((c) => ({
        ...c,
        state: stateAt(c.seenAt),
        tickets: tickets.filter((t) => t.coordinator === c.name).map((t) => t.id),
        updateAvailable: outdated(c.cliVersion),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    timeline.coordinators.push({
      project: p.slug,
      inboxTrack: coordinatorTrack({ reads: p.live?.inboxReads ?? [], silentAfterMinutes, now: input.now }),
    });
    projects.push({
      main: p.report?.main ?? null,
      owner: p.owner ?? null,
      progress: p.report?.progress ?? null,
      health: p.report
        ? projectHealth({
            tickets,
            prs: p.report.pullRequests ?? [],
            inbox,
            coordinator: state,
            coordinatorMinutes: p.report.coordinatorMinutes,
            now: input.now,
          })
        : null,
      pullRequests: p.report?.pullRequests ?? null,
      merged: p.report?.merged ?? [],
      jobs: (p.report?.jobs ?? []).map(({ ref: _ref, startedBy: _by, ...job }) => job),
      requests: inbox.filter((item) => REQUEST_KINDS.includes(item.kind as (typeof REQUEST_KINDS)[number])),
      slug: p.slug,
      name: p.name,
      repository: p.repository,
      programRoot: p.report?.programRoot ?? null,
      coordinator: {
        ...p.live?.coordinator,
        state,
        seenAt,
        cliVersion,
        updateAvailable: outdated(cliVersion),
      },
      coordinators,
      inFlight: tickets.length,
      waiting: perTicket.size + projectWide,
      sources: p.report?.sources ?? null,
      profiles: Object.entries(p.profiles ?? {}).map(([name, c]) => ({
        name,
        agent: c.agent,
        model: c.model,
        effort: c.effort,
      })),
      error: p.error,
      reading: p.reading ?? false,
      warnings: [...(p.warnings ?? []), ...(p.report?.warnings ?? [])],
    });
  }

  waiting.sort((a, b) => rank(a.kind) - rank(b.kind) || a.since.localeCompare(b.since));
  validations.sort((a, b) =>
    !a.decision !== !b.decision
      ? a.decision
        ? 1
        : -1
      : a.decision && b.decision
        ? b.decision.at.localeCompare(a.decision.at)
        : a.createdAt.localeCompare(b.createdAt),
  );
  rows.sort(
    (a, b) =>
      rank(a.waiting) - rank(b.waiting) ||
      b.pipeline.step - a.pipeline.step ||
      a.project.localeCompare(b.project) ||
      a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  return {
    sessions,
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    generatedAt: input.now.toISOString(),
    live: input.live,
    projects,
    waiting,
    rows,
    ready,
    validations,
    timeline,
  };
}
