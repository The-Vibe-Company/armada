// The overview by coordinator (THE-916): the sessions in flight, one group
// per project's coordinator, and what "À valider" means everywhere: an owner
// validation still open on a session (THE-885: work to validate, a merge to
// approve or a question escalated to the owner). A worker's question, plan or
// hand-back is the coordinator's to handle, not the owner's. Pure: it reads
// the overview the shell polls.
import {
  FLOW_STEPS,
  type FleetOverview,
  type FleetRow,
  type FlowStep,
  type OwnerValidation,
  type ProjectOverview,
} from "@armada/core/read";
import { AGENT_STATUSES, agentState } from "./fleet-view";
import { pendingValidations } from "./overview-view";

type Validations = Partial<Pick<FleetOverview, "validations">>;

const key = (project: string, ticket: string) => `${project}/${ticket}`;

/** What the owner has to validate on each session, oldest first; a session without one is absent. */
export function ownerChecks(o: Validations): Map<string, OwnerValidation[]> {
  const out = new Map<string, OwnerValidation[]>();
  for (const v of [...pendingValidations(o)].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const k = key(v.project, v.ticket);
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

/** What the owner has to validate on one session, oldest first. */
export const checksOf = (checks: Map<string, OwnerValidation[]>, row: Pick<FleetRow, "project" | "id">) =>
  checks.get(key(row.project, row.id)) ?? [];

/** What the owner has to validate in one project. */
export const projectChecks = (o: Validations, slug: string) =>
  pendingValidations(o).filter((v) => v.project === slug).length;

export interface CoordinatorGroup {
  project: ProjectOverview;
  /** Its sessions shown, those to validate first. */
  rows: FleetRow[];
  /** What the owner has to validate in the project. */
  toValidate: number;
}

const STATUS_ORDER = (r: FleetRow) => AGENT_STATUSES.indexOf(agentState(r).status);

/**
 * One group per coordinator, from the sessions a view keeps (`rows`, in its
 * order). In a group, the sessions to validate come first, then, in the list's
 * own order (`sorted` false), the most urgent status first; a sort the viewer
 * chose is kept after that. The groups with something to validate come first,
 * then the overview's order. `empty` keeps a coordinator with no session shown.
 */
export function coordinatorGroups(
  o: Pick<FleetOverview, "projects"> & Validations,
  rows: FleetRow[],
  { sorted = false, empty = true }: { sorted?: boolean; empty?: boolean } = {},
): CoordinatorGroup[] {
  const checks = ownerChecks(o);
  const owner = (r: FleetRow) => (checksOf(checks, r).length ? 0 : 1);
  const groups = o.projects.flatMap((project) => {
    const own = rows.filter((r) => r.project === project.slug);
    if (!own.length && !empty) return [];
    // Array.prototype.sort is stable: equal rows keep the view's order.
    const ordered = own.sort((a, b) => owner(a) - owner(b) || (sorted ? 0 : STATUS_ORDER(a) - STATUS_ORDER(b)));
    return [{ project, rows: ordered, toValidate: projectChecks(o, project.slug) }];
  });
  return groups.sort((a, b) => (a.toValidate ? 0 : 1) - (b.toValidate ? 0 : 1));
}

/**
 * The board's columns (THE-968, THE-988), left to right: a ticket's flow, from
 * its plan to its merge (core's flow steps). What needs the owner, what is
 * stuck and what is silent are badges on the cards, not columns.
 */
export const BOARD_COLUMNS = FLOW_STEPS;
export type BoardColumn = FlowStep;

/** A lane's sessions by column, each in its group's order. */
export function laneColumns(rows: FleetRow[]): Record<BoardColumn, FleetRow[]> {
  const out = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as FleetRow[]])) as Record<BoardColumn, FleetRow[]>;
  for (const r of rows) out[r.step].push(r);
  return out;
}

/** The badges a session's card carries, most urgent first (THE-988). */
export const CARD_BADGES = ["validate", "blocked", "silent", "approval", "ready"] as const;
export type CardBadge = (typeof CARD_BADGES)[number];

/**
 * A card's badges: "To validate" while an owner validation is open on it,
 * "Blocked" on a worker's question, "Silent", "Plan to approve" and "Ready to
 * merge" from its phase.
 */
export function cardBadges(
  checks: Map<string, OwnerValidation[]>,
  row: Pick<FleetRow, "project" | "id" | "phase" | "silent" | "question">,
): CardBadge[] {
  const on: Record<CardBadge, boolean> = {
    validate: checksOf(checks, row).length > 0,
    blocked: row.phase === "blocked" || !!row.question,
    silent: row.silent,
    approval: row.phase === "awaiting-approval",
    ready: row.phase === "ready-to-merge",
  };
  return CARD_BADGES.filter((b) => on[b]);
}

/** The overview's one line: "2 coordinators · 6 sessions in flight · 1 to validate". */
export function overviewLine(o: Pick<FleetOverview, "projects" | "rows"> & Validations) {
  return { coordinators: o.projects.length, running: o.rows.length, toValidate: pendingValidations(o).length };
}
