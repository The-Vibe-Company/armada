import { describe, expect, test } from "bun:test";
import { buildInsights } from "@armada/core/read";
import { blockedMs, mergeBars, percent } from "../lib/insights-view.ts";

const NOW = new Date("2026-03-11T12:00:00Z");
const merge = (ticket: string, at: string) => ({
  ticket,
  kind: "merge" as const,
  phase: "merged",
  headSha: null,
  at,
  gapFrom: null,
  last: true,
});
const insights = (range: "7d" | "90d") =>
  buildInsights({
    records: [
      {
        project: "widgets",
        silentAfterMinutes: 15,
        events: [
          merge("W-0", "2026-03-03T09:00:00.000Z"),
          merge("W-1", "2026-03-10T09:00:00.000Z"),
          merge("W-2", "2026-03-11T09:00:00.000Z"),
        ],
        sessions: [],
        waits: [],
        validations: [],
      },
    ],
    range,
    now: NOW,
  });

describe("the Insights page (THE-1021)", () => {
  test("draws the merges of each of the last seven days, oldest first", () => {
    expect(mergeBars(insights("7d"))).toEqual([
      { day: "2026-03-05", count: 0 },
      { day: "2026-03-06", count: 0 },
      { day: "2026-03-07", count: 0 },
      { day: "2026-03-08", count: 0 },
      { day: "2026-03-09", count: 0 },
      { day: "2026-03-10", count: 1 },
      { day: "2026-03-11", count: 1 },
    ]);
  });

  test("reads the time blocked from core's phases, and a rate as a whole percent", () => {
    const phases = [
      { phase: "implementing" as const, totalMs: 5_000, medianMs: null, tickets: [] },
      { phase: "blocked" as const, totalMs: 7_200_000, medianMs: null, tickets: [] },
    ];
    expect(blockedMs({ phases })).toBe(7_200_000);
    expect(blockedMs({ phases: [] })).toBe(0);
    expect(percent(0.716)).toBe(72);
    expect(percent(null)).toBeNull();
  });
});
