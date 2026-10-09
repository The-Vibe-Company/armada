// Owner alerts shared by browser notifications and chat deliveries. Pure.
import { CONFIG_DEFAULTS } from "./config.ts";
import { coordinatorAlerts, pendingValidations } from "./coordinator-alerts.ts";
import type { FleetOverview } from "./overview.ts";
import { REQUEST_KINDS } from "./request-kinds.ts";

export { type CoordinatorAlert, coordinatorAlerts, pendingValidations } from "./coordinator-alerts.ts";

export interface OwnerItem {
  /** Stable across polls and tabs: a notification is shown once per key. */
  key: string;
  kind: "validation" | "question" | "coordinator" | "unattended";
  project: string;
  ticket: string | null;
  title: string;
  /** Where the notification opens. */
  href: string;
  /** `coordinator`: how many items wait for it. */
  waiting: number;
  /** Unattended work: label and age for localized browser/chat titles. */
  reason?: string;
  minutes?: number;
  workTitle?: string;
}

type Notifiable = Pick<FleetOverview, "projects" | "waiting"> &
  Partial<Pick<FleetOverview, "validations" | "live" | "generatedAt">>;

/** What waits for the owner now, oldest first. */
export function ownerItems(o: Notifiable): OwnerItem[] {
  if (o.live && o.live.state !== "ok") return [];
  const items: OwnerItem[] = pendingValidations(o).map((v) => ({
    key: `validation:${v.project}:${v.id}`,
    project: v.project,
    ticket: v.ticket,
    kind: v.kind === "question" ? "question" : "validation",
    title: v.kind === "secret" ? `${v.secretName} · ${v.project}` : v.title ? `${v.ticket} · ${v.title}` : v.ticket,
    href: `/approve/${v.id}`,
    waiting: 0,
  }));
  const names = new Map(o.projects.map((p) => [p.slug, p.name]));
  for (const c of coordinatorAlerts(o))
    items.push({
      // A coordinator that stops again after coming back is news again.
      key: `coordinator:${c.project}:${c.name && c.name !== "default" ? `${c.name}:` : ""}${c.seenAt ?? ""}`,
      kind: "coordinator",
      project: c.project,
      ticket: null,
      title: `${names.get(c.project) ?? c.project}${c.name && c.name !== "default" ? ` · ${c.name}` : ""}`,
      href: `/projects/${encodeURIComponent(c.project)}`,
      waiting: c.waiting,
    });
  const now = Date.parse(o.generatedAt ?? "");
  const reasons: Record<string, string> = {
    question: "question to answer",
    plan: "plan to approve",
    "hand-back": "merge to review",
    decision: "owner decision",
    "answer-request": "answer to deliver",
    "launch-request": "launch request",
    "merge-request": "merge request",
    "release-request": "release request",
    "plan-changes": "plan changes",
  };
  for (const p of o.projects) {
    const threshold = 3 * (p.coordinatorMinutes ?? CONFIG_DEFAULTS.coordinatorMinutes) * 60_000;
    for (const i of p.inbox ?? []) {
      if (!["question", "plan", "hand-back", "decision", ...REQUEST_KINDS].includes(i.kind)) continue;
      const age = now - Date.parse(i.createdAt);
      if (!Number.isFinite(age) || age <= threshold) continue;
      const active = i.coordinator
        ? (p.coordinators?.find((c) => c.name === i.coordinator)?.state ??
            (i.coordinator === "default" ? p.coordinator.state : "unknown")) === "active"
        : (p.coordinators?.some((c) => c.state === "active") ?? p.coordinator.state === "active");
      if (!active) continue;
      if (
        (i.kind === "hand-back" || i.kind === "merge-request") &&
        ((p.holds?.length ?? 0) > 0 ||
          p.queue?.some(
            (q) =>
              q.state !== "refused" &&
              (i.kind === "merge-request" && i.pr != null ? q.pr === i.pr : q.ticket === i.ticket),
          ))
      )
        continue;
      const minutes = Math.floor(age / 60_000);
      const reason = reasons[i.kind] as string;
      const workTitle = i.ticket ? `${i.ticket}${i.title ? ` · ${i.title}` : ""}` : (i.title ?? p.name);
      items.push({
        key: `unattended:${p.slug}:${i.id}`,
        kind: "unattended",
        project: p.slug,
        ticket: i.ticket,
        title: `${workTitle} — ${reason}, waiting ${minutes} min for the coordinator`,
        href: i.ticket ? `/agents/${encodeURIComponent(i.ticket)}` : `/projects/${encodeURIComponent(p.slug)}`,
        waiting: 0,
        reason,
        minutes,
        workTitle,
      });
    }
  }
  return items;
}
