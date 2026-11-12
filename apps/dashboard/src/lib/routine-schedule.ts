/** Human controls compile to standard cron; calendar evaluation belongs to the API. */
export type RoutinePreset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export type RoutineScheduleChoice = {
  preset: RoutinePreset;
  time: string;
  weekdays: readonly number[];
  dayOfMonth: string;
  custom: string;
};
export type RoutineSchedulePreview = {
  cron: string;
  timezone: string;
  description: string;
  nextRuns: string[];
  asOf: string;
};
export function presetToCron(choice: RoutineScheduleChoice): { ok: true; cron: string } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (choice.preset === "custom") {
    const cron = choice.custom.trim();
    return cron && cron.length <= 200 && !cron.includes("\0")
      ? { ok: true, cron }
      : bad("Enter a five-field cron expression.");
  }
  if (choice.preset === "hourly") return { ok: true, cron: "0 * * * *" };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(choice.time)) return bad("Choose a time.");
  const [hour, minute] = choice.time.split(":").map(Number);
  const at = `${minute} ${hour}`;
  if (choice.preset === "daily") return { ok: true, cron: `${at} * * *` };
  if (choice.preset === "weekdays") return { ok: true, cron: `${at} * * 1-5` };
  if (choice.preset === "weekly") {
    if (!choice.weekdays.length || choice.weekdays.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6))
      return bad("Choose at least one day.");
    return { ok: true, cron: `${at} * * ${[...new Set(choice.weekdays)].sort((a, b) => a - b).join(",")}` };
  }
  if (choice.preset === "monthly") {
    if (!/^(?:[1-9]|[12]\d|3[01])$/.test(choice.dayOfMonth)) return bad("Choose a day between 1 and 31.");
    return { ok: true, cron: `${at} ${choice.dayOfMonth} * *` };
  }
  return bad("Choose a schedule.");
}
