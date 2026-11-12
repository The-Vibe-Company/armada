import { expect, test } from "bun:test";
import { presetToCron, type RoutineScheduleChoice } from "../src/lib/routine-schedule.ts";

const daily: RoutineScheduleChoice = {
  preset: "daily",
  time: "09:05",
  weekdays: [1],
  dayOfMonth: "1",
  custom: "0 9 * * *",
};

// These controls own cron compilation, not calendar parsing or timezone recurrence.
test("human schedule presets produce the standard cron submitted to the API", () => {
  for (const [choice, cron] of [
    [{ ...daily, preset: "hourly" }, "0 * * * *"],
    [daily, "5 9 * * *"],
    [{ ...daily, preset: "weekdays" }, "5 9 * * 1-5"],
    [{ ...daily, preset: "weekly", weekdays: [5, 0, 1, 1] }, "5 9 * * 0,1,5"],
    [{ ...daily, preset: "monthly", dayOfMonth: "31", time: "00:00" }, "0 0 31 * *"],
    [{ ...daily, preset: "custom", custom: "  15 */2 * * MON-FRI  " }, "15 */2 * * MON-FRI"],
  ] as const)
    expect(presetToCron(choice)).toEqual({ ok: true, cron });
});

test("incomplete human controls cannot submit a guessed schedule; custom recurrence stays API-validated", () => {
  for (const patch of [
    { time: "" },
    { time: "24:00" },
    { time: "09:60" },
    { preset: "weekly", weekdays: [] },
    { preset: "weekly", weekdays: [7] },
    { preset: "monthly", dayOfMonth: "0" },
    { preset: "monthly", dayOfMonth: "32" },
    { preset: "monthly", dayOfMonth: "1.5" },
    { preset: "custom", custom: "" },
    { preset: "custom", custom: "x".repeat(201) },
  ] as const)
    expect(presetToCron({ ...daily, ...patch }).ok).toBe(false);
  // The server preview, not this human-control compiler, validates custom recurrence.
  expect(presetToCron({ ...daily, preset: "custom", custom: "*/5 * * * *" })).toEqual({
    ok: true,
    cron: "*/5 * * * *",
  });
});
