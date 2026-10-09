// Browser notifications for what needs the owner (THE-894): a validation to
// decide (a merge to approve, work to validate), a question the coordinator
// escalated to them, a coordinator that stopped while items wait for it.
// Neglected coordinator work reaches the owner after three coordinator thresholds.
// Phase changes alone never notify. Pure: the shell's Notifier keeps what it already notified,
// reads the viewer's settings and shows each new item once, outside their
// quiet hours. The live region says the same in the page (lib/announce.ts).
import type { OwnerItem } from "@armada/core/read";

export type { OwnerItem } from "@armada/core/read";

import type { MILESTONE_TITLES, Strings } from "./i18n";

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

/** Shared browser/chat title; channel milestones never enter browser ownerItems. */
export function channelNotificationTitle(t: Strings, item: OwnerItem, milestones: typeof MILESTONE_TITLES.en): string {
  if (item.kind === "spec-closed") return milestones.specClosed(item.title);
  if (item.kind === "hold-opened") return milestones.holdOpened(item.title, item.reason ?? "");
  if (item.kind === "hold-cleared") return milestones.holdCleared(item.title);
  return notificationTitle(t, item);
}

/** Browser titles stay independent of the channel-only milestone formatter. */
export function notificationTitle(t: Strings, item: OwnerItem): string {
  if (item.kind === "question") return t.notify.question(item.title);
  if (item.kind === "validation") return t.notify.validation(item.title);
  if (item.kind === "unattended")
    return t.notify.unattended(item.workTitle ?? item.title, item.reason ?? "", item.minutes ?? 0);
  return t.notify.coordinator(item.title, item.waiting);
}

/** The account menu checks support without loading the notification handler. */
export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;
