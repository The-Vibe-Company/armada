// Browser notifications for what needs the owner (THE-894): a validation to
// decide (a merge to approve, work to validate), a question the coordinator
// escalated to them, a coordinator that stopped while items wait for it.
// Never a worker's question, plan or hand-back (the coordinator's), never a
// phase change. Pure: the shell's Notifier keeps what it already notified,
// reads the viewer's settings and shows each new item once, outside their
// quiet hours. The live region says the same in the page (lib/announce.ts).
import type { FleetOverview, SinceSummary } from "@armada/core/read";
import { paths } from "./fleet-view";
import type { Strings } from "./i18n";
import { coordinatorAlerts, pendingValidations } from "./overview-view";

/** Browser notifications for what waits for the owner, and the hours they stay quiet (local time, `HH:MM`). */
export interface NotifySettings {
  on: boolean;
  quiet: { from: string; to: string } | null;
}

export const NOTIFY_OFF: NotifySettings = { on: false, quiet: null };

/** What the shell's visit beacon answers (`/api/fleet/visit`). */
export interface VisitAnswer {
  /** Where "since you were away" starts; null when there is no summary to show. */
  since: string | null;
  summary: SinceSummary | null;
  notify: NotifySettings;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Settings as the browser sent them, or null when they are not settings. */
export function notifyOf(v: unknown): NotifySettings | null {
  if (!v || typeof v !== "object") return null;
  const { on, quiet } = v as { on?: unknown; quiet?: unknown };
  if (typeof on !== "boolean") return null;
  if (quiet === null || quiet === undefined) return { on, quiet: null };
  const { from, to } = quiet as { from?: unknown; to?: unknown };
  if (typeof from !== "string" || typeof to !== "string" || !CLOCK.test(from) || !CLOCK.test(to) || from === to)
    return null;
  return { on, quiet: { from, to } };
}

export interface OwnerItem {
  /** Stable across polls and tabs: a notification is shown once per key. */
  key: string;
  kind: "validation" | "question" | "coordinator";
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
    kind: v.kind === "question" ? "question" : "validation",
    title: v.title ? `${v.ticket} · ${v.title}` : `${v.ticket} · ${v.what}`,
    href: paths.validation(v.id),
    waiting: 0,
  }));
  const names = new Map(o.projects.map((p) => [p.slug, p.name]));
  for (const c of coordinatorAlerts(o))
    items.push({
      // A coordinator that stops again after coming back is news again.
      key: `coordinator:${c.project}:${c.seenAt ?? ""}`,
      kind: "coordinator",
      title: names.get(c.project) ?? c.project,
      href: paths.project(c.project),
      waiting: c.waiting,
    });
  return items;
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Whether `at`, in the browser's time, falls in the quiet hours; they may run over midnight. */
export function inQuietHours(quiet: NotifySettings["quiet"], at: Date): boolean {
  if (!quiet) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * What to show now: the owner items not shown yet, when notifications are on
 * and the hours are not quiet. An item that arrives in quiet hours is not
 * shown later: the page and the sidebar keep it.
 */
export function toNotify(
  items: OwnerItem[],
  shown: ReadonlySet<string>,
  settings: NotifySettings,
  at: Date,
): OwnerItem[] {
  if (!settings.on || inQuietHours(settings.quiet, at)) return [];
  return items.filter((i) => !shown.has(i.key));
}

/** A notification's title. */
export function notificationTitle(t: Strings, item: OwnerItem): string {
  if (item.kind === "question") return t.notify.question(item.title);
  if (item.kind === "validation") return t.notify.validation(item.title);
  return t.notify.coordinator(item.title, item.waiting);
}
