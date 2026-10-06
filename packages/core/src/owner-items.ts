// Owner alerts shared by browser notifications and chat deliveries. Pure.
import type { CoordinatorState, FleetOverview, OwnerValidation } from "./overview.ts";

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

export interface OwnerItem {
  /** Stable across polls and tabs: a notification is shown once per key. */
  key: string;
  kind: "validation" | "question" | "coordinator";
  project: string;
  ticket: string | null;
  title: string;
  /** Where the notification opens. */
  href: string;
  /** `coordinator`: how many items wait for it. */
  waiting: number;
}

type Notifiable = Pick<FleetOverview, "projects" | "waiting"> & Partial<Pick<FleetOverview, "validations">>;

/** What waits for the owner now, oldest first. */
export function ownerItems(o: Notifiable): OwnerItem[] {
  const items: OwnerItem[] = pendingValidations(o).map((v) => ({
    key: `validation:${v.project}:${v.id}`,
    project: v.project,
    ticket: v.ticket,
    kind: v.kind === "question" ? "question" : "validation",
    title: v.title ? `${v.ticket} · ${v.title}` : v.ticket,
    href: `/approve/${v.id}`,
    waiting: 0,
  }));
  const names = new Map(o.projects.map((p) => [p.slug, p.name]));
  for (const c of coordinatorAlerts(o))
    items.push({
      // A coordinator that stops again after coming back is news again.
      key: `coordinator:${c.project}:${c.seenAt ?? ""}`,
      kind: "coordinator",
      project: c.project,
      ticket: null,
      title: names.get(c.project) ?? c.project,
      href: `/projects/${encodeURIComponent(c.project)}`,
      waiting: c.waiting,
    });
  return items;
}
