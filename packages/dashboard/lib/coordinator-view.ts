// The overview by coordinator (THE-916): the sessions in flight, one group
// per project's coordinator, and what "À valider" means everywhere: an owner
// validation still open on a session (THE-885: work to validate, a merge to
// approve or a question escalated to the owner). A worker's question, plan or
// hand-back is the coordinator's to handle, not the owner's. Pure: it reads
// the overview the shell polls.
import type { FleetOverview, FleetRow, OwnerValidation, ProjectOverview } from "@armada/core/read";
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

/** The overview's one line: "2 coordinators · 6 sessions in flight · 1 to validate". */
export function overviewLine(o: Pick<FleetOverview, "projects" | "rows"> & Validations) {
  return { coordinators: o.projects.length, running: o.rows.length, toValidate: pendingValidations(o).length };
}
