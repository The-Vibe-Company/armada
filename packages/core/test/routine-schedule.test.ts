import { expect, test } from "bun:test";
import { advanceRoutineSchedule, nextRoutineDates, parseRoutineSchedule } from "../src/routine-schedule.ts";

// Owns calendar recurrence, timezone interpretation and the abuse guard. The service
// boundary separately owns membership/reference admission; these tests need no IO.
const next = (cron: string, timezone: string, after: string) =>
  nextRoutineDates(parseRoutineSchedule(cron, timezone), new Date(after)).map((date) => date.toISOString());

test("standard five fields normalize aliases and describe the same weekday schedule in 24-hour words", () => {
  const saved = parseRoutineSchedule("  0  9 * * MON-FRI  ", "Europe/Paris");
  expect(saved).toEqual({
    cron: "0 9 * * MON-FRI",
    timezone: "Europe/Paris",
    description: "At 09:00, Monday through Friday, Europe/Paris",
  });
  expect(next(saved.cron, saved.timezone, "2026-11-13T08:00:00.000Z")).toEqual([
    "2026-11-16T08:00:00.000Z",
    "2026-11-17T08:00:00.000Z",
    "2026-11-18T08:00:00.000Z",
  ]);
  expect(next("0 9 * * *", "US/Eastern", "2026-11-12T10:00:00.000Z")[0]).toBe("2026-11-12T14:00:00.000Z");
});

test("next runs exclude the reference instant and do not depend on a previously consumed iterator", () => {
  const schedule = parseRoutineSchedule("0 * * * *", "UTC");
  const after = new Date("2026-11-12T10:00:00.000Z");
  expect(nextRoutineDates(schedule, after, 1).map((date) => date.toISOString())).toEqual(["2026-11-12T11:00:00.000Z"]);
  expect(nextRoutineDates(schedule, after).map((date) => date.toISOString())).toEqual([
    "2026-11-12T11:00:00.000Z",
    "2026-11-12T12:00:00.000Z",
    "2026-11-12T13:00:00.000Z",
  ]);
  expect(after.toISOString()).toBe("2026-11-12T10:00:00.000Z");
});

test("daily schedules cross DST gaps and folds without assuming a fixed UTC offset", () => {
  expect(next("30 2 * * *", "America/New_York", "2027-03-13T08:00:00.000Z")).toEqual([
    "2027-03-14T07:00:00.000Z",
    "2027-03-15T06:30:00.000Z",
    "2027-03-16T06:30:00.000Z",
  ]);
  // A repeated local hour does not cause the same daily occurrence to fire twice.
  expect(next("30 1 * * *", "America/New_York", "2027-11-06T08:00:00.000Z")).toEqual([
    "2027-11-07T05:30:00.000Z",
    "2027-11-08T06:30:00.000Z",
    "2027-11-09T06:30:00.000Z",
  ]);
  expect(next("45 2 * * *", "Australia/Lord_Howe", "2027-10-01T00:00:00.000Z")).toEqual([
    "2027-10-01T16:15:00.000Z",
    "2027-10-02T15:45:00.000Z",
    "2027-10-03T15:45:00.000Z",
  ]);
});

test("calendar dates handle leap days, missing month days and standard day-or-weekday semantics", () => {
  expect(next("0 9 29 2 *", "UTC", "2026-11-12T10:00:00.000Z")).toEqual([
    "2028-02-29T09:00:00.000Z",
    "2032-02-29T09:00:00.000Z",
    "2036-02-29T09:00:00.000Z",
  ]);
  expect(next("0 9 31 * *", "UTC", "2027-01-31T09:00:00.000Z")).toEqual([
    "2027-03-31T09:00:00.000Z",
    "2027-05-31T09:00:00.000Z",
    "2027-07-31T09:00:00.000Z",
  ]);
  const union = parseRoutineSchedule("0 9 1 * MON", "UTC");
  expect(union.description).toContain(", or ");
  expect(next(union.cron, union.timezone, "2026-11-29T10:00:00.000Z")).toEqual([
    "2026-11-30T09:00:00.000Z",
    "2026-12-01T09:00:00.000Z",
    "2026-12-07T09:00:00.000Z",
  ]);
  // Full date ranges are restricted selectors, not wildcards: normalizing must preserve the union.
  expect(next("0 9 1-31 * MON", "UTC", "2026-11-12T09:00:00.000Z")[0]).toBe("2026-11-13T09:00:00.000Z");
});

test("rare-date and list/step schedules cannot evade the one-hour minimum", () => {
  for (const cron of ["* * * * *", "*/30 * * * *", "0,30 9 * * MON", "0,1 9 29 2 *"])
    expect(() => parseRoutineSchedule(cron, "UTC")).toThrow("at least one hour apart");
  expect(next("15 */2 * * *", "Etc/GMT+5", "2026-11-12T10:15:00.000Z")[0]).toBe("2026-11-12T11:15:00.000Z");
});

test("invalid cron dialects, impossible calendars and bad zones produce closed readable errors", () => {
  for (const cron of [
    "",
    "@hourly",
    "0 0 9 * * *",
    "H * * * *",
    "0 9 L * *",
    "0 9 * * MON#2",
    "0 9 ? * *",
    "61 9 * * *",
    "0 25 * * *",
    "0 9 31 FEB *",
    "x".repeat(201),
  ]) {
    expect(() => parseRoutineSchedule(cron, "UTC")).toThrow("valid five-field cron");
  }
  for (const timezone of ["", "+01:00", "Europe/Unknown", "private-value-not-a-zone", null]) {
    expect(() => parseRoutineSchedule("0 9 * * *", timezone)).toThrow("valid IANA time zone");
  }
  const schedule = parseRoutineSchedule("0 9 * * *", "UTC");
  for (const count of [0, 4, 1.5])
    expect(() => nextRoutineDates(schedule, new Date(0), count)).toThrow("one and three");
  expect(() => nextRoutineDates(schedule, new Date(Number.NaN))).toThrow("valid reference time");
});

test("half-hour DST transitions cannot compress an hourly schedule, including a rare April date", () => {
  for (const cron of ["45 * * * *", "45 * 1 4 *"])
    expect(() => parseRoutineSchedule(cron, "Australia/Lord_Howe")).toThrow("at least one hour apart");
  // A different minute crosses the same spring transition without a sub-hour gap.
  expect(next("0 * * * *", "Australia/Lord_Howe", "2027-10-02T14:00:00.000Z")).toEqual([
    "2027-10-02T14:30:00.000Z",
    "2027-10-02T16:00:00.000Z",
    "2027-10-02T17:00:00.000Z",
  ]);
});

test("runtime neighbors enforce minimum spacing even outside the forward validation horizon", () => {
  // Kathmandu no longer changes offset, so forward validation accepts hourly :45.
  // Its historical 15-minute jump gives 23:45 -> 00:45 a real gap of only 45 min.
  const schedule = parseRoutineSchedule("45 * * * *", "Asia/Kathmandu");
  expect(() => nextRoutineDates(schedule, new Date("1985-12-31T18:20:00Z"), 1)).toThrow("at least one hour apart");
});

test("advancing skips missed slots without catch-up and bounds long-outage counts", () => {
  const hourly = parseRoutineSchedule("0 * * * *", "UTC");
  expect(advanceRoutineSchedule(hourly, new Date("2026-11-12T10:00:00Z"), new Date("2026-11-12T18:30:00Z"))).toEqual({
    nextDueAt: new Date("2026-11-12T19:00:00Z"),
    missedOccurrences: 8,
    missedCountCapped: false,
  });
  expect(advanceRoutineSchedule(hourly, new Date("2026-11-12T10:00:00Z"), new Date("2026-11-12T10:00:00Z"))).toEqual({
    nextDueAt: new Date("2026-11-12T11:00:00Z"),
    missedOccurrences: 0,
    missedCountCapped: false,
  });
  expect(advanceRoutineSchedule(hourly, new Date("2000-01-01T00:00:00Z"), new Date("2026-11-12T18:00:00Z"))).toEqual({
    nextDueAt: new Date("2026-11-12T19:00:00Z"),
    missedOccurrences: 1000,
    missedCountCapped: true,
  });
  const annual = parseRoutineSchedule("0 9 1 JAN *", "UTC");
  expect(advanceRoutineSchedule(annual, new Date("2020-01-01T09:00:00Z"), new Date("2025-01-01T09:00:00Z"))).toEqual({
    nextDueAt: new Date("2026-01-01T09:00:00Z"),
    missedOccurrences: 5,
    missedCountCapped: false,
  });
  expect(() =>
    advanceRoutineSchedule(hourly, new Date("2026-11-13T00:00:00Z"), new Date("2026-11-12T00:00:00Z")),
  ).toThrow("valid due and current reference times");
});
