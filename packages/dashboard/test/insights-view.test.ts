import { describe, expect, test } from "bun:test";
import { buildInsights } from "@armada/core/read";
import type { InsightsReading } from "../lib/fleet-data.ts";
import {
  behindOf,
  insightsHref,
  insightsQuery,
  shippedBars,
  showOf,
  ticketHref,
  ticketsBehind,
} from "../lib/insights-view.ts";

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

describe("the Insights address", () => {
  test("reads the range, the project and the number opened; anything else falls back", () => {
    expect(insightsQuery({ range: "90d", project: "widgets", show: "merged" })).toEqual({
      range: "90d",
      project: "widgets",
      show: "merged",
    });
    expect(insightsQuery({ range: "1y", project: "../x", show: undefined })).toEqual({
      range: "30d",
      project: null,
      show: null,
    });
  });

  test("leaves the default range out", () => {
    expect(insightsHref({})).toBe("/insights");
    expect(insightsHref({ range: "30d", project: "widgets" })).toBe("/insights?project=widgets");
    expect(insightsHref({ range: "7d", show: "day:2026-03-10" })).toBe("/insights?range=7d&show=day%3A2026-03-10");
  });

  test("every number it opens reads back as itself; a made-up one opens nothing", () => {
    for (const show of [
      "merged",
      "cycle",
      "first-pass",
      "redone",
      "silences",
      "day:2026-03-10",
      "week:2026-03-09",
      "phase:shipping",
      "waits:owner",
      "profile:opus",
      "harness:codex",
    ]) {
      const b = behindOf(show);
      expect(b && showOf(b)).toBe(show);
    }
    for (const show of ["phase:lunch", "waits:everyone", "day:yesterday", "merged:1", "nope", "profile:"])
      expect(behindOf(show)).toBeNull();
  });
});

describe("the tickets behind a number", () => {
  test("a day's merges, and where each ticket opens", () => {
    const i = insights("7d");
    expect(ticketsBehind(i, { kind: "day", day: "2026-03-10" }).map((t) => t.ticket)).toEqual(["W-1"]);
    expect(ticketsBehind(i, { kind: "merged" }).map((t) => t.ticket)).toEqual(["W-2", "W-1"]);
    const reading = {
      tickets: {
        "widgets/W-1": { title: "One", url: "https://linear.app/acme/issue/W-1", inFlight: false },
        "widgets/W-2": { title: "Two", url: "https://linear.app/acme/issue/W-2", inFlight: true },
      },
    } as unknown as InsightsReading;
    expect(ticketHref(reading, "widgets", "W-1")).toBe("https://linear.app/acme/issue/W-1");
    expect(ticketHref(reading, "widgets", "W-2")).toBe("/agents/W-2");
    expect(ticketHref(reading, "widgets", "W-9")).toBeNull();
  });

  test("the shipped chart draws days up to a month, weeks beyond, each beside the period before's", () => {
    expect(shippedBars(insights("7d")).map((b) => [b.key, b.count, b.previous])).toEqual([
      ["2026-03-05", 0, 0],
      ["2026-03-06", 0, 0],
      ["2026-03-07", 0, 0],
      ["2026-03-08", 0, 0],
      ["2026-03-09", 0, 0],
      ["2026-03-10", 1, 1],
      ["2026-03-11", 1, 0],
    ]);
    const weeks = shippedBars(insights("90d"));
    expect(weeks.every((b) => b.kind === "week")).toBe(true);
    expect(weeks.at(-1)).toEqual({ key: "2026-03-09", kind: "week", count: 2, previous: 0 });
  });
});
