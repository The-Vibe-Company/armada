import { Cron, CronPattern } from "croner";
import cronstrue from "cronstrue";
import { VaultError } from "./vault-error.ts";

export type RoutineSchedule = { cron: string; timezone: string; description: string };
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const REFERENCE = new Date("2000-01-01T00:00:00Z");
const numericField = /^[0-9*,/-]+$/;
const zoneWindows = new Map<string, [number, number][]>();
const schedules = new Map<string, Readonly<RoutineSchedule>>();

function invalid(message = "Use a valid five-field cron expression (minute, hour, day, month, weekday)."): never {
  throw new VaultError("invalid", message);
}
function minimumGap(): never {
  return invalid("Routines must be at least one hour apart in the selected time zone.");
}
function zone(input: unknown): string {
  if (typeof input !== "string" || input.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(input.trim()))
    invalid("Choose a valid IANA time zone, such as Europe/Paris or UTC.");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: input.trim() }).resolvedOptions().timeZone;
  } catch {
    return invalid("Choose a valid IANA time zone, such as Europe/Paris or UTC.");
  }
}
function expression(input: unknown): string {
  if (typeof input !== "string" || input.length > 200) invalid();
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 5) invalid();
  // Limit the dialect here; ranges, expansion and calendar validation belong to Croner.
  if (fields.slice(0, 3).some((field) => !numericField.test(field))) invalid();
  const month = (fields[3] ?? "").replace(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/gi, "1");
  const weekday = (fields[4] ?? "").replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, "1");
  if (!numericField.test(month) || !numericField.test(weekday)) invalid();
  // Preserve */ranges rather than expanding them: fixed and interval schedules have
  // intentionally different Vixie DST semantics in the maintained engine.
  return fields.join(" ").toUpperCase();
}
function describe(cron: string, timezone: string, parsed: CronPattern): string {
  const options = { use24HourTimeFormat: true, throwExceptionOnParseError: true, locale: "en" };
  const fields = cron.split(" ");
  if (!parsed.starDOM && !parsed.starDOW) {
    const byDate = [...fields],
      byWeekday = [...fields];
    byDate[4] = "*";
    byWeekday[2] = "*";
    const weekdayText = cronstrue.toString(byWeekday.join(" "), options);
    return `${cronstrue.toString(byDate.join(" "), options)}, or ${weekdayText.charAt(0).toLowerCase()}${weekdayText.slice(1)}, ${timezone}`;
  }
  return `${cronstrue.toString(cron, options)}, ${timezone}`;
}
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  cache.delete(key);
  cache.set(key, value);
  const oldest = cache.keys().next().value;
  if (cache.size > limit && oldest !== undefined) cache.delete(oldest);
  return value;
}
function windows(timezone: string, year: number): [number, number][] {
  const key = `${year}:${timezone}`;
  const cached = zoneWindows.get(key);
  if (cached) return remember(zoneWindows, key, cached, 32);
  const result: [number, number][] = [];
  if (timezone === "UTC" || /^Etc\/(?:UTC|GMT(?:[+-]\d+)?)$/.test(timezone))
    return remember(zoneWindows, key, result, 32);
  const formatter = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "longOffset" });
  const offset = (instant: number): string => {
    const text = formatter.formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value;
    if (!text || !/^GMT(?:[+-]\d{2}:\d{2}(?::\d{2})?)?$/.test(text))
      invalid("The selected time zone could not be evaluated safely.");
    return text;
  };
  let previous = offset(Date.UTC(year, 0, 1) - DAY);
  // 28 years cover the Gregorian weekday/leap-year cycle outside century changes.
  // Runtime neighbour checks below also protect historical/future rules outside it.
  for (let sample = Date.UTC(year, 0, 1); sample <= Date.UTC(year + 28, 0, 1) + DAY; sample += DAY) {
    const current = offset(sample);
    if (current !== previous) result.push([sample - 2 * DAY, sample + 2 * DAY]);
    previous = current;
  }
  return remember(zoneWindows, key, result, 32);
}
function job(schedule: Pick<RoutineSchedule, "cron" | "timezone">, stopAt?: Date): Cron {
  return new Cron(schedule.cron, {
    timezone: schedule.timezone,
    mode: "5-part",
    paused: true,
    ...(stopAt ? { stopAt } : {}),
  });
}
function pairs(dates: Date[]): void {
  let previous: Date | undefined;
  for (const date of dates) {
    if (previous && date.getTime() - previous.getTime() < HOUR) minimumGap();
    previous = date;
  }
}

/** Validate without creating any timers or callbacks. Only this maintained engine expands cron fields. */
export function parseRoutineSchedule(cron: unknown, timezone: unknown): RoutineSchedule {
  const normalized = expression(cron),
    tz = zone(timezone),
    year = new Date().getUTCFullYear();
  const key = `${year}:${tz}:${normalized}`;
  const cached = schedules.get(key);
  if (cached) return { ...remember(schedules, key, cached, 128) };
  try {
    const parsed = new CronPattern(normalized, tz, { mode: "5-part" });
    // Multiple minutes violate the minimum even on rare dates far beyond a preview.
    if (parsed.minute.filter(Boolean).length !== 1) minimumGap();
    const schedule = { cron: normalized, timezone: tz, description: describe(normalized, tz, parsed) };
    const calendar = job(schedule, new Date("2400-01-01T00:00:00Z"));
    try {
      if (!calendar.nextRun(REFERENCE)) invalid();
    } finally {
      calendar.stop();
    }
    // Non-hour offset changes can compress even a one-minute-per-hour schedule.
    // Inspect actual adjacent occurrences around every transition, not merely the
    // first few runs (a restricted April date can encounter a fold years later).
    for (const [start, end] of windows(tz, year)) {
      const calendar = job(schedule, new Date(end));
      try {
        pairs(calendar.nextRuns(100, new Date(start)));
      } finally {
        calendar.stop();
      }
    }
    remember(schedules, key, Object.freeze(schedule), 128);
    return { ...schedule };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    return invalid();
  }
}

/** Strictly after the supplied instant; never shares mutable iterator state. */
export function nextRoutineDates(schedule: Pick<RoutineSchedule, "cron" | "timezone">, after: Date, count = 3): Date[] {
  if (
    !(after instanceof Date) ||
    !Number.isFinite(after.getTime()) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 3
  )
    invalid("Choose a valid reference time and between one and three next runs.");
  const validated = parseRoutineSchedule(schedule.cron, schedule.timezone);
  const calendar = job(validated);
  try {
    const dates = calendar.nextRuns(count + 1, after);
    if (dates.length < count || dates.some((date) => date.getTime() <= after.getTime()))
      invalid("The schedule has no next run after the selected reference time.");
    // Include the preceding slot, even when it predates `after`, plus the following
    // slot. This protects every admission beyond the cached validation horizon.
    const first = dates[0];
    if (!first) invalid("The schedule has no next run after the selected reference time.");
    pairs([...calendar.previousRuns(1, first), ...dates]);
    return dates.slice(0, count);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    return invalid("The schedule has no next run after the selected reference time.");
  } finally {
    calendar.stop();
  }
}

/** No catch-up storm: report a bounded missed count and jump straight past now. */
export function advanceRoutineSchedule(
  schedule: Pick<RoutineSchedule, "cron" | "timezone">,
  due: Date,
  now: Date,
): {
  nextDueAt: Date;
  missedOccurrences: number;
  missedCountCapped: boolean;
} {
  if (
    !(due instanceof Date) ||
    !(now instanceof Date) ||
    !Number.isFinite(due.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    due > now
  )
    invalid("Choose valid due and current reference times.");
  const validated = parseRoutineSchedule(schedule.cron, schedule.timezone);
  const nextDueAt = nextRoutineDates(validated, now, 1)[0];
  if (!nextDueAt) invalid("The schedule has no next run after the selected reference time.");
  // Croner stopAt is exclusive; include an occurrence exactly at now.
  const elapsed = job(validated, new Date(now.getTime() + 1));
  try {
    const missed = elapsed.nextRuns(1000, due);
    return { nextDueAt, missedOccurrences: missed.length, missedCountCapped: missed.length === 1000 };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    return invalid("The missed schedule occurrences could not be evaluated safely.");
  } finally {
    elapsed.stop();
  }
}
