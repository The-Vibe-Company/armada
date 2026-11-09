const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago `iso` was at `now`, in the table's short English: "just now", "5 min ago", "2 hours ago",
 * "3 days ago", "4 months ago", "2 years ago". A time in the future (clock skew) reads "just now", never a negative
 * age. Null when `iso` is not a date.
 */
export function relativeAge(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then) || !Number.isFinite(now)) return null;
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), "hour");
  const days = Math.floor(elapsed / DAY);
  if (days < 30) return ago(days, "day");
  if (days < 365) return ago(Math.floor(days / 30), "month");
  return ago(Math.floor(days / 365), "year");
}

function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * The exact moment in the zone of the runtime it runs in, with that zone: "Nov 8, 2026, 11:05 AM GMT+1
 * (Europe/Paris)". Only shown in the browser (a tooltip mounts once opened), so it is the viewer's own zone. Null when
 * `iso` is not a date.
 */
export function exactLocalTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const format = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${format.format(date)} (${format.resolvedOptions().timeZone})`;
}
