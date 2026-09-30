// The fleet of every registered project in one reading: the rows of the
// dashboard's Fleet view (one per ticket in flight, across projects) and the
// list of what waits for the owner. Pure: the dashboard reads the sources,
// calls `buildOverview` and renders the result as is.
import type { InFlightTicket, StatusReport } from "./status.ts";
import type { InboxItem } from "./turso.ts";
import type { AgentPhase } from "./types.ts";

export const OVERVIEW_SCHEMA_VERSION = 1;

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
export const WAITING_KINDS = ["question", "blocked", "approval", "hand-back", "silent"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface WaitingItem {
  kind: WaitingKind;
  project: string;
  ticket: string | null;
  title: string | null;
  url: string | null;
  /** The question, the hand-back note or the worker's last status. */
  detail: string | null;
  author: string | null;
  /** Since when it waits. */
  since: string;
}

export interface FleetRow extends InFlightTicket {
  project: string;
  /** The oldest open question of this ticket in the coordinator's inbox. */
  question: { body: string; at: string; author: string | null } | null;
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
  /** Set when the project could not be read at all. */
  error: string | null;
  warnings: string[];
}

/** One project as the dashboard read it. */
export interface ProjectReading {
  slug: string;
  name: string;
  repository: string;
  report: StatusReport | null;
  error: string | null;
  warnings?: string[];
  /** Null when Turso was not read. */
  live: { inbox: InboxItem[]; coordinatorSeenAt: string | null } | null;
}

export interface FleetOverview {
  schemaVersion: typeof OVERVIEW_SCHEMA_VERSION;
  generatedAt: string;
  /** Turso: ok, unreachable (the view falls back to Linear and GitHub) or off (not configured). */
  live: { state: "ok" | "unreachable" | "off"; error: string | null };
  projects: ProjectOverview[];
  waiting: WaitingItem[];
  rows: FleetRow[];
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

  for (const p of input.projects) {
    const tickets = p.report?.inFlight ?? [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const inbox = (p.live?.inbox ?? []).filter((i) => i.recipient === "coordinator");
    const questions = new Map<string, InboxItem>();
    for (const q of inbox)
      if (q.kind === "question" && q.ticket && !questions.has(q.ticket)) questions.set(q.ticket, q);

    // One waiting item per ticket: its most urgent reason. Project-wide items stay separate.
    const perTicket = new Map<string, WaitingItem>();
    let projectWide = 0;
    const offer = (item: WaitingItem) => {
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
      if (item.kind !== "question" && item.kind !== "hand-back") continue;
      offer({
        kind: item.kind,
        project: p.slug,
        ticket: item.ticket,
        ...about(item.ticket),
        detail: item.body,
        author: item.author,
        since: item.createdAt,
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
      });
    }
    waiting.push(...perTicket.values());

    for (const t of tickets) {
      const q = questions.get(t.id);
      rows.push({
        ...t,
        project: p.slug,
        question: q ? { body: q.body, at: q.createdAt, author: q.author } : null,
        pipeline: pipeline(t),
        waiting: perTicket.get(t.id)?.kind ?? null,
      });
    }

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
      error: p.error,
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
  };
}
