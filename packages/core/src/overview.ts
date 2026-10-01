// The fleet of every registered project in one reading: the rows of the
// dashboard's Fleet view (one per ticket in flight, across projects) and the
// list of what waits for the owner. Pure: the dashboard reads the sources,
// calls `buildOverview` and renders the result as is.
import { CONFIG_DEFAULTS, type ConductorProfile } from "./config.ts";
import type { InboxItem } from "./live.ts";
import type { FrontierTicket, InFlightTicket, StatusReport } from "./status.ts";
import type { AgentPhase } from "./types.ts";

export const OVERVIEW_SCHEMA_VERSION = 2;

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
  project: string;
  /** The oldest open question of this ticket in the coordinator's inbox. */
  question: { id: number; body: string; at: string; author: string | null; answer: PendingAnswer | null } | null;
  pipeline: Pipeline;
  /** Set when the row is in the waiting list. */
  waiting: WaitingKind | null;
}

export type CoordinatorState = "active" | "idle" | "unknown";

export interface ProjectOverview {
  slug: string;
  name: string;
  repository: string;
  programRoot: StatusReport["programRoot"] | null;
  /** Active when it read its inbox within the project's silence threshold. */
  coordinator: { state: CoordinatorState; seenAt: string | null };
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

/** One project as the dashboard read it. */
export interface ProjectReading {
  slug: string;
  name: string;
  repository: string;
  report: StatusReport | null;
  error: string | null;
  /** No reading yet, and one is under way. */
  reading?: boolean;
  warnings?: string[];
  /** Null when the live data was not read. */
  live: { inbox: InboxItem[]; coordinatorSeenAt: string | null } | null;
  /** `[conductor.profiles]` of its armada.toml. */
  profiles?: Record<string, ConductorProfile>;
}

export interface FleetOverview {
  schemaVersion: typeof OVERVIEW_SCHEMA_VERSION;
  generatedAt: string;
  /** The live data: ok, unreachable (the view falls back to Linear and GitHub) or off (not configured). */
  live: { state: "ok" | "unreachable" | "off"; error: string | null };
  projects: ProjectOverview[];
  waiting: WaitingItem[];
  rows: FleetRow[];
  /** Tickets ready to start, per project in frontier order (best first). */
  ready: ReadyTicket[];
}

const MIN = 60_000;
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
}): FleetOverview {
  const now = input.now.getTime();
  const rows: FleetRow[] = [];
  const waiting: WaitingItem[] = [];
  const projects: ProjectOverview[] = [];
  const ready: ReadyTicket[] = [];

  for (const p of input.projects) {
    const tickets = p.report?.inFlight ?? [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const inbox = (p.live?.inbox ?? []).filter((i) => i.recipient === "coordinator");
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
        since: kind === "silent" ? (t.lastReport ?? t.lastUpdate) : t.since,
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

    for (const t of tickets) {
      const q = questions.get(t.id);
      rows.push({
        ...t,
        project: p.slug,
        question: q
          ? { id: q.id, body: q.body, at: q.createdAt, author: q.author, answer: answers.get(q.id) ?? null }
          : null,
        pipeline: pipeline(t),
        waiting: perTicket.get(t.id)?.kind ?? null,
      });
    }

    for (const f of p.report?.frontier ?? []) ready.push({ ...f, project: p.slug, launch: launches.get(f.id) ?? null });

    const seenAt = p.live?.coordinatorSeenAt ?? null;
    const threshold = (p.report?.silentAfterMinutes ?? 15) * MIN;
    projects.push({
      slug: p.slug,
      name: p.name,
      repository: p.repository,
      programRoot: p.report?.programRoot ?? null,
      coordinator: {
        state: seenAt === null ? "unknown" : now - Date.parse(seenAt) <= threshold ? "active" : "idle",
        seenAt,
      },
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
  rows.sort(
    (a, b) =>
      rank(a.waiting) - rank(b.waiting) ||
      b.pipeline.step - a.pipeline.step ||
      a.project.localeCompare(b.project) ||
      a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  return {
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    generatedAt: input.now.toISOString(),
    live: input.live,
    projects,
    waiting,
    rows,
    ready,
  };
}
