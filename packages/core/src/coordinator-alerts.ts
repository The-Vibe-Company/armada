// Coordinator stop alerts and owner validations shared by the shell and deliveries. Pure.
import type { CoordinatorState, FleetOverview, OwnerValidation } from "./overview.ts";

/**
 * A coordinator that stopped answering while items wait for it: only the
 * owner can bring it back. Late inbox counts are scoped to each named owner.
 */
export interface CoordinatorAlert {
  project: string;
  name?: string;
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
    // Compatibility for overviews produced before per-owner inbox counts existed.
    if (p.coordinator.late === undefined) {
      const { state, seenAt } = p.coordinator;
      const late = o.waiting.flatMap((w) => (w.project === p.slug && w.coordinatorSince ? [w.coordinatorSince] : []));
      if (state !== "active" && late.length)
        alerts.push({ project: p.slug, state, seenAt, waiting: late.length, since: late.sort()[0] as string });
      continue;
    }
    for (const c of p.coordinators ?? []) {
      if (c.state === "active" || !c.late || !c.lateSince) continue;
      alerts.push({
        project: p.slug,
        name: c.name,
        state: c.state,
        seenAt: c.seenAt,
        waiting: c.late,
        since: c.lateSince,
      });
    }
    const c = p.coordinator;
    if (!(p.coordinators ?? []).some((c) => c.state === "active") && c.state !== "active" && c.late && c.lateSince) {
      const existing = alerts.find((a) => a.project === p.slug && a.name === "default");
      if (existing) {
        existing.waiting += c.late;
        if (c.lateSince < existing.since) existing.since = c.lateSince;
      } else alerts.push({ project: p.slug, state: c.state, seenAt: c.seenAt, waiting: c.late, since: c.lateSince });
    }
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
