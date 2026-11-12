import { parseRoutineSchedule, type RoutineSchedule } from "./routine-schedule.ts";

/** UTC phase bridge for old interval API requests, never an approximation for e.g.25h. */
export function cronForLegacyInterval(hours: number, anchor: Date): RoutineSchedule | null {
  if (24 % hours !== 0 && hours !== 168) return null;
  const minute = new Date(Math.ceil(anchor.getTime() / 60_000) * 60_000);
  const m = minute.getUTCMinutes(),
    h = minute.getUTCHours();
  const expression =
    hours === 168
      ? `${m} ${h} * * ${minute.getUTCDay()}`
      : hours === 1
        ? `${m} * * * *`
        : hours === 24
          ? `${m} ${h} * * *`
          : `${m} ${h % hours}-23/${hours} * * *`;
  return parseRoutineSchedule(expression, "UTC");
}
