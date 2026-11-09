import { expect, test } from "bun:test";
import { relativeAge } from "../src/lib/relative-time.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");

test("a creation time reads as its age, never negative and never NaN", () => {
  const cases: [string, string | null][] = [
    ["2026-11-09T11:59:30Z", "just now"],
    ["2026-11-09T11:55:00Z", "5 min ago"],
    ["2026-11-09T11:00:01Z", "59 min ago"],
    ["2026-11-09T11:00:00Z", "1 hour ago"],
    ["2026-11-09T10:00:00Z", "2 hours ago"],
    ["2026-11-08T12:00:00Z", "1 day ago"],
    ["2026-10-30T12:00:00Z", "10 days ago"],
    ["2026-09-10T12:00:00Z", "2 months ago"],
    ["2024-11-09T12:00:00Z", "2 years ago"],
    // Clock skew: a time ahead of the viewer's clock is not an age below zero.
    ["2026-11-09T12:03:00Z", "just now"],
    ["not a date", null],
    ["", null],
  ];
  expect(cases.map(([iso]) => [iso, relativeAge(iso, NOW)])).toEqual(cases);
});
