// The overview's view rules (THE-867): its headline figures, the decisions
// waiting for the owner (THE-880: with the coordinators that stopped answering)
// and each project's card. Pure: they read the overview the shell polls, and
// never recompute what core decides (health, progress, what waits, since when
// an item waits for the coordinator).
import type { CoordinatorState, FleetOverview, InboxItem, OwnerValidation, WaitingItem } from "@armada/core/read";
import { agentState, type DecisionKind, decisionsOf, harnessOf } from "./fleet-view";
import { lastActivity, prCounts, progressPercent } from "./project-view";

/** A question, a plan or a hand-back: what the owner decides. */
export type Decision = WaitingItem & { kind: DecisionKind };

export interface OverviewFigures {
  inFlight: number;
  /** What waits for the owner's check, and stopped coordinators: the sidebar's count. */
  decide: number;
  failing: number;
  silent: number;
  coordinators: { active: number; total: number };
  projects: number;
  /** The harnesses the sessions in flight run on. */
  harnesses: number;
}

export function overviewFigures(
  o: Pick<FleetOverview, "rows" | "waiting" | "projects"> & Partial<Pick<FleetOverview, "validations">>,
): OverviewFigures {
  const states = o.rows.map((r) => agentState(r).status);
  return {
    inFlight: o.rows.length,
    decide: decideCount(o),
    failing: states.filter((s) => s === "error").length,
    silent: states.filter((s) => s === "silent").length,
    coordinators: {
      active: o.projects.filter((p) => p.coordinator.state === "active").length,
      total: o.projects.length,
    },
    projects: o.projects.length,
    harnesses: new Set(o.rows.map((r) => harnessOf(r.runtime))).size,
  };
}

/**
 * A coordinator that stopped answering while items wait for it: only the
 * owner can bring it back. One per project, from core's `coordinatorSince`
 * (an item open in its inbox longer than `policy.coordinator_minutes`).
 */
export interface CoordinatorAlert {
  project: string;
  state: Exclude<CoordinatorState, "active">;
  /** Its last command; null when it never ran one. */
  seenAt: string | null;
  /** The items waiting for it. */
  waiting: number;
  /** Since when the oldest of them waits for it. */
  since: string;
}

export function coordinatorAlerts(o: Pick<FleetOverview, "projects" | "waiting">): CoordinatorAlert[] {
  const alerts: CoordinatorAlert[] = [];
  for (const p of o.projects) {
    const { state, seenAt } = p.coordinator;
    if (state === "active") continue;
    const late = o.waiting.flatMap((w) => (w.project === p.slug && w.coordinatorSince ? [w.coordinatorSince] : []));
    if (late.length === 0) continue;
    alerts.push({ project: p.slug, state, seenAt, waiting: late.length, since: late.sort()[0] as string });
  }
  return alerts.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * What waits for the owner's check (THE-885): merges to approve, work to
 * validate, questions the coordinator escalated, oldest first. An overview
 * from before validations existed has none.
 */
export const pendingValidations = (o: Partial<Pick<FleetOverview, "validations">>): OwnerValidation[] =>
  (o.validations ?? []).filter((v) => !v.decision);

/** What the owner decided this week, newest first. */
export const decidedValidations = (o: Partial<Pick<FleetOverview, "validations">>): OwnerValidation[] =>
  (o.validations ?? []).filter((v) => v.decision);

/** What the owner has to decide: what waits for their check, and the coordinators to bring back. */
export const decideCount = (
  o: Pick<FleetOverview, "projects" | "waiting"> & Partial<Pick<FleetOverview, "validations">>,
) => pendingValidations(o).length + coordinatorAlerts(o).length;

/**
 * What the coordinator handles, in one line on the overview: the workers'
 * questions, plans and hand-backs, how many and since when the oldest waits.
 * Null when nothing waits for it.
 */
export function withCoordinator(o: Pick<FleetOverview, "waiting">): { count: number; since: string } | null {
  const items = decisionsOf(o);
  if (!items.length) return null;
  return { count: items.length, since: items.map((w) => w.since).sort()[0] as string };
}

/** The decisions an agent's page offers, oldest first: a question to answer, a plan to approve. */
export const decisionCards = (o: Pick<FleetOverview, "waiting">): Decision[] =>
  [...decisionsOf(o)].sort((a, b) => a.since.localeCompare(b.since));

const RECOMMENDED = /\b(recommended\b|recommand)/i;

/** A question's options, the recommended one first; else in the worker's order (the first is its pick). */
export function orderOptions(options: readonly string[]): string[] {
  const pick = options.findIndex((o) => RECOMMENDED.test(o));
  if (pick <= 0) return [...options];
  return [options[pick] as string, ...options.filter((_, k) => k !== pick)];
}

/** At most `max` characters of a text, cut on a word, with an ellipsis. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The pull request a hand-back asks to merge: its row's, else the project's open one for the ticket. */
export function handBackPr(o: Pick<FleetOverview, "rows" | "projects">, w: WaitingItem): number | null {
  if (!w.ticket) return null;
  const row = o.rows.find((r) => r.project === w.project && r.id === w.ticket);
  if (row?.pr) return row.pr.number;
  const project = o.projects.find((p) => p.slug === w.project);
  return project?.pullRequests?.find((pr) => pr.ticket?.id === w.ticket)?.number ?? null;
}

/** A request already waiting for the coordinator on a decision. */
export interface SentRequest {
  body: string;
  author: string | null;
  at: string;
}

/**
 * What the owner already asked about a decision, as the server holds it: the
 * answer to a question or plan, amendments to a plan, the merge of a hand-back.
 */
export function sentRequest(o: Pick<FleetOverview, "projects">, w: WaitingItem, pr: number | null): SentRequest | null {
  if (w.answer) return { body: w.answer.body, author: w.answer.author, at: w.answer.at };
  const requests = o.projects.find((p) => p.slug === w.project)?.requests ?? [];
  const match = (r: InboxItem) =>
    w.kind === "approval"
      ? r.kind === "plan-changes" && w.item !== null && r.request?.question === w.item
      : w.kind === "hand-back" && r.kind === "merge-request" && pr !== null && r.request?.pr === pr;
  const r = requests.find(match);
  return r ? { body: r.body, author: r.author, at: r.createdAt } : null;
}

export interface ProjectFacts {
  /** Done tickets out of all under the root, in percent (`progressPercent`); null when unknown. */
  progress: number | null;
  inFlight: number;
  /** Tickets marked ready to start, or whose launch was asked. */
  ready: number;
  /** Null when GitHub was not read. */
  prs: { open: number; green: number } | null;
  /** The latest report of its agents or command of its coordinator. */
  lastActivity: string | null;
}

export function projectFacts(o: Pick<FleetOverview, "rows" | "ready" | "projects">, slug: string): ProjectFacts {
  const p = o.projects.find((x) => x.slug === slug);
  const rows = o.rows.filter((r) => r.project === slug);
  return {
    progress: progressPercent(p?.progress ?? null),
    inFlight: rows.length,
    ready: o.ready.filter((r) => r.project === slug && (r.readyForAgent || r.launch)).length,
    prs: prCounts(p?.pullRequests ?? null),
    lastActivity: p ? lastActivity(p, rows) : null,
  };
}
