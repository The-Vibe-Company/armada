import { describe, expect, test } from "bun:test";
import {
  buildInsights,
  type InsightEvent,
  type InsightSession,
  insightsSummary,
  type ProjectInsightRecords,
  quantile,
} from "../src/insights.ts";

// A Wednesday: the 7-day range starts on Thursday 5 March, 00:00 UTC, and the previous one a week before.
const NOW = new Date("2026-03-11T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (day: string, time = "10:00") => `2026-${day}T${time}:00.000Z`;

const ev = (
  ticket: string,
  kind: InsightEvent["kind"],
  when: string,
  over: Partial<InsightEvent> = {},
): InsightEvent => ({ ticket, kind, phase: null, headSha: null, at: when, gapFrom: null, last: false, ...over });
const claim = (ticket: string, when: string) => ev(ticket, "claim", when, { phase: "planning" });
const report = (ticket: string, phase: string, when: string, headSha: string | null = null) =>
  ev(ticket, "report", when, { phase, headSha });
const merge = (ticket: string, when: string) => ev(ticket, "merge", when, { phase: "merged" });
const session = (ticket: string, claimedAt: string, over: Partial<InsightSession> = {}): InsightSession => ({
  ticket,
  runtime: "Conductor",
  profile: "opus",
  claimedAt,
  releasedAt: null,
  ...over,
});

const records = (over: Partial<ProjectInsightRecords> = {}): ProjectInsightRecords => ({
  project: "widgets",
  silentAfterMinutes: 15,
  events: [],
  sessions: [],
  waits: [],
  validations: [],
  ...over,
});

const insights = (...r: ProjectInsightRecords[]) => buildInsights({ records: r, range: "7d", now: NOW });
const ids = (list: { ticket: string }[]) => list.map((t) => t.ticket);

describe("quantile", () => {
  test("is the nearest rank: always one of the values", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe("throughput", () => {
  const i = insights(
    records({
      events: [
        merge("W-1", at("03-05", "09:00")),
        merge("W-2", at("03-05", "17:00")),
        merge("W-3", at("03-10")),
        merge("W-4", at("03-01")),
        merge("W-5", at("02-20")),
      ],
    }),
  );

  test("counts merges per UTC day of the range, and the previous period's", () => {
    expect(i.from).toBe("2026-03-05T00:00:00.000Z");
    expect(i.previousFrom).toBe("2026-02-26T00:00:00.000Z");
    expect(i.days.map((d) => d.day)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
    ]);
    expect(i.days.map((d) => d.tickets.length)).toEqual([2, 0, 0, 0, 0, 1, 0]);
    expect(i.merged.count).toBe(3);
    expect(i.merged.previous).toBe(1);
    expect(ids(i.merged.tickets)).toEqual(["W-3", "W-2", "W-1"]);
  });

  test("groups them by ISO week, named by its Monday", () => {
    expect(i.weeks.map((w) => [w.week, ids(w.tickets)])).toEqual([
      ["2026-03-02", ["W-1", "W-2"]],
      ["2026-03-09", ["W-3"]],
    ]);
  });
});

describe("the previous period", () => {
  test("is the same stretch of time a period earlier: a steady pace reads flat early in the day", () => {
    const early = new Date("2026-03-11T01:00:00Z");
    const events = Array.from({ length: 14 }, (_, k) =>
      merge(`W-${k}`, new Date(Date.parse("2026-02-26T12:00:00Z") + k * 24 * HOUR).toISOString()),
    );
    const i = buildInsights({ records: [records({ events })], range: "7d", now: early });
    expect([i.merged.count, i.merged.previous]).toEqual([6, 6]);
    expect(insightsSummary(i).change).toBe(0);
  });
});

describe("cycle time", () => {
  test("runs from the first claim since the previous merge, even before the range", () => {
    const i = insights(
      records({
        events: [
          // Claimed before the range, released, claimed again: the cycle starts at the first claim.
          claim("W-1", at("02-25")),
          ev("W-1", "release", at("02-26")),
          claim("W-1", at("03-04")),
          merge("W-1", at("03-06")),
          // Merged twice: the second cycle starts at the claim after the first merge.
          claim("W-2", at("03-05", "08:00")),
          merge("W-2", at("03-05", "09:00")),
          claim("W-2", at("03-06", "08:00")),
          merge("W-2", at("03-06", "12:00")),
          // A merge no claim started (a ticket done by hand) counts as shipped, without a cycle.
          merge("W-3", at("03-07")),
          // Last week's cycle, for the trend.
          claim("W-4", at("02-27", "10:00")),
          merge("W-4", at("02-27", "11:00")),
        ],
      }),
    );
    expect(i.merged.count).toBe(4);
    expect(i.cycle.count).toBe(3);
    expect(i.cycle.tickets.map((t) => [t.ticket, t.value])).toEqual([
      ["W-1", 9 * 24 * HOUR],
      ["W-2", 4 * HOUR],
      ["W-2", HOUR],
    ]);
    expect(i.cycle.p50).toBe(4 * HOUR);
    expect(i.cycle.p90).toBe(9 * 24 * HOUR);
    expect(i.cycle.previousP50).toBe(HOUR);
    expect(i.cycle.daily).toEqual([HOUR, 4 * HOUR, null, null, null, null, null]);
  });
});

describe("time in each phase", () => {
  test("adds up each merged ticket's stretches between its reports", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-05", "10:00")),
          report("W-1", "awaiting-approval", at("03-05", "11:00")),
          report("W-1", "implementing", at("03-05", "12:00")),
          report("W-1", "implementing", at("03-05", "13:00")),
          report("W-1", "shipping", at("03-05", "15:00")),
          report("W-1", "ready-to-merge", at("03-05", "16:00"), "a1"),
          merge("W-1", at("03-05", "18:00")),
          // Released overnight: the hours no worker held it count in no phase.
          claim("W-2", at("03-06", "10:00")),
          ev("W-2", "release", at("03-06", "11:00")),
          ev("W-2", "claim", at("03-07", "10:00"), { phase: "implementing" }),
          merge("W-2", at("03-07", "12:00")),
          // Not merged yet: not in the phase times.
          claim("W-3", at("03-08")),
        ],
      }),
    );
    const of = Object.fromEntries(i.phases.map((p) => [p.phase, p]));
    expect(of.planning?.totalMs).toBe(2 * HOUR);
    expect(of.planning?.medianMs).toBe(HOUR);
    expect(of["awaiting-approval"]?.totalMs).toBe(HOUR);
    expect(of.implementing?.totalMs).toBe(5 * HOUR);
    expect(ids(of.implementing?.tickets ?? [])).toEqual(["W-1", "W-2"]);
    expect(of.shipping?.totalMs).toBe(HOUR);
    expect(of["ready-to-merge"]?.totalMs).toBe(2 * HOUR);
    expect(of.blocked?.totalMs).toBe(0);
    expect(of.blocked?.medianMs).toBeNull();
  });
});

describe("waiting time", () => {
  test("the coordinator's: a question, plan or hand-back to its resolution; the open ones apart", () => {
    const i = insights(
      records({
        waits: [
          { ticket: "W-1", kind: "question", createdAt: at("03-05"), resolvedAt: at("03-05", "10:30") },
          { ticket: "W-2", kind: "hand-back", createdAt: at("03-06"), resolvedAt: at("03-06", "12:00") },
          { ticket: "W-3", kind: "plan", createdAt: at("03-11", "11:00"), resolvedAt: null },
          // Answered, but asked before the range.
          { ticket: "W-4", kind: "question", createdAt: at("03-01"), resolvedAt: at("03-06") },
          // Still open from before the range: it waits now.
          { ticket: "W-5", kind: "question", createdAt: at("03-04", "12:00"), resolvedAt: null },
        ],
      }),
    );
    expect(i.waits.coordinator).toMatchObject({ count: 2, p50: 30 * MIN, p90: 2 * HOUR, open: 2 });
    expect(i.waits.coordinator.tickets.map((t) => [t.ticket, t.value])).toEqual([
      ["W-5", 7 * 24 * HOUR],
      ["W-2", 2 * HOUR],
      ["W-3", HOUR],
      ["W-1", 30 * MIN],
    ]);
  });

  test("the owner's: a validation to its decision; a superseded one is no wait", () => {
    const i = insights(
      records({
        validations: [
          {
            ticket: "W-1",
            kind: "merge",
            createdAt: at("03-05"),
            decidedAt: at("03-05", "11:00"),
            outcome: "approved",
          },
          {
            ticket: "W-2",
            kind: "validation",
            createdAt: at("03-06"),
            decidedAt: at("03-06", "10:05"),
            outcome: "superseded",
          },
          { ticket: "W-3", kind: "question", createdAt: at("03-11", "09:00"), decidedAt: null, outcome: null },
        ],
      }),
    );
    expect(i.waits.owner).toMatchObject({ count: 1, p50: HOUR, open: 1 });
    expect(ids(i.waits.owner.tickets)).toEqual(["W-3", "W-1"]);
  });
});

describe("first-pass green", () => {
  test("a merged ticket handed back on one head; each new head after the hand-back is a redo", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-05", "08:00")),
          report("W-1", "ready-to-merge", at("03-05", "09:00"), "a1"),
          report("W-1", "ready-to-merge", at("03-05", "09:30"), "a1"),
          merge("W-1", at("03-05", "10:00")),
          claim("W-2", at("03-05", "08:00")),
          report("W-2", "ready-to-merge", at("03-05", "09:00"), "b1"),
          report("W-2", "shipping", at("03-05", "09:10")),
          report("W-2", "ready-to-merge", at("03-05", "09:40"), "b2"),
          merge("W-2", at("03-05", "10:00")),
          // Merged without a hand-back (a design ticket): not counted.
          claim("W-3", at("03-05", "08:00")),
          merge("W-3", at("03-05", "10:00")),
        ],
      }),
    );
    expect(i.firstPass).toMatchObject({ green: 1, handedBack: 2, rate: 0.5 });
    expect(ids(i.firstPass.tickets)).toEqual(["W-1"]);
    expect(i.firstPass.redone.map((t) => [t.ticket, t.value])).toEqual([["W-2", 1]]);
  });
});

describe("silences", () => {
  test("a gap longer than the threshold while working, not while waiting, and the one going on now", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-10", "08:00")),
          report("W-1", "implementing", at("03-10", "08:10")),
          ev("W-1", "heartbeat", at("03-10", "09:00"), { gapFrom: at("03-10", "08:20") }),
          report("W-1", "awaiting-approval", at("03-10", "09:05")),
          // Waiting for the coordinator: no heartbeat for an hour is no silence.
          ev("W-1", "report", at("03-10", "10:05"), { phase: "implementing", gapFrom: at("03-10", "09:05") }),
          ev("W-1", "heartbeat", at("03-11", "11:00"), { last: true }),
        ],
        sessions: [session("W-1", at("03-10", "08:00"))],
      }),
    );
    expect(i.silences.count).toBe(2);
    expect(i.silences.tickets.map((t) => [t.at, t.value])).toEqual([
      [at("03-11", "11:00"), HOUR],
      [at("03-10", "08:20"), 40 * MIN],
    ]);
    // Held from Tuesday 08:00 to now (Wednesday 12:00).
    expect(i.silences.workerHours).toBe(28);
    expect(i.silences.perWorkerHour).toBeCloseTo(2 / 28);
  });

  test("a released ticket has no silence going on, and a gap after a release is none", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-10", "08:00")),
          ev("W-1", "release", at("03-10", "09:00")),
          ev("W-1", "claim", at("03-11", "08:00"), { phase: "implementing", gapFrom: at("03-10", "09:00") }),
          merge("W-1", at("03-11", "09:00")),
        ].map((e, k, all) => (k === all.length - 1 ? { ...e, last: true } : e)),
        sessions: [
          session("W-1", at("03-10", "08:00"), { releasedAt: at("03-10", "09:00") }),
          session("W-1", at("03-11", "08:00"), { releasedAt: at("03-11", "09:00") }),
        ],
      }),
    );
    expect(i.silences.count).toBe(0);
    expect(i.silences.workerHours).toBe(2);
  });
});

describe("profiles and harnesses", () => {
  const i = insights(
    records({
      events: [
        claim("W-1", at("03-05", "08:00")),
        report("W-1", "awaiting-approval", at("03-05", "08:30")),
        report("W-1", "planning", at("03-05", "09:00")),
        report("W-1", "awaiting-approval", at("03-05", "09:30")),
        report("W-1", "ready-to-merge", at("03-05", "10:00"), "a1"),
        report("W-1", "ready-to-merge", at("03-05", "11:00"), "a2"),
        merge("W-1", at("03-05", "12:00")),
        claim("W-2", at("03-06", "08:00")),
        merge("W-2", at("03-06", "09:00")),
        claim("W-3", at("03-06", "08:00")),
        ev("W-3", "heartbeat", at("03-06", "09:00"), { gapFrom: at("03-06", "08:00") }),
        merge("W-3", at("03-06", "10:00")),
      ],
      sessions: [
        session("W-1", at("03-05", "08:00"), { releasedAt: at("03-05", "12:00") }),
        session("W-2", at("03-06", "08:00"), {
          releasedAt: at("03-06", "09:00"),
          profile: "codex",
          runtime: "claude-code",
        }),
        session("W-3", at("03-06", "08:00"), { releasedAt: at("03-06", "10:00"), profile: "codex", runtime: "codex" }),
      ],
    }),
  );

  test("compare cycle time, re-plans, new heads and silences per profile", () => {
    expect(i.profiles).toEqual([
      {
        key: "codex",
        merged: 2,
        cycleP50: HOUR,
        replans: 0,
        newHeads: 0,
        silences: 1,
        workerHours: 3,
        silencesPerWorkerHour: 1 / 3,
        tickets: expect.any(Array),
      },
      {
        key: "opus",
        merged: 1,
        cycleP50: 4 * HOUR,
        replans: 1,
        newHeads: 1,
        silences: 0,
        workerHours: 4,
        silencesPerWorkerHour: 0,
        tickets: expect.any(Array),
      },
    ]);
    expect(ids(i.profiles[0]?.tickets ?? [])).toEqual(["W-3", "W-2"]);
  });

  test("and per harness, from the session's runtime", () => {
    expect(i.harnesses.map((h) => [h.key, h.merged, h.workerHours])).toEqual([
      ["conductor", 1, 4],
      ["codex", 1, 2],
      ["claude-code", 1, 1],
    ]);
  });
});

describe("where tickets wait", () => {
  test("ranks the stretches in a phase that waits on someone, the one going on included", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-05", "08:00")),
          report("W-1", "blocked", at("03-05", "09:00")),
          report("W-1", "implementing", at("03-05", "09:20")),
          report("W-1", "ready-to-merge", at("03-05", "10:00"), "a1"),
          merge("W-1", at("03-05", "13:00")),
          claim("W-2", at("03-11", "08:00")),
          report("W-2", "awaiting-validation", at("03-11", "10:00")),
          // Released while waiting: that stretch ended with no one to wait for.
          claim("W-3", at("03-10", "08:00")),
          report("W-3", "blocked", at("03-10", "09:00")),
        ],
        sessions: [
          session("W-2", at("03-11", "08:00")),
          session("W-3", at("03-10", "08:00"), { releasedAt: at("03-10", "10:00") }),
        ],
      }),
    );
    expect(i.biggestWaits.map((w) => [w.ticket, w.phase, w.ms, w.to])).toEqual([
      ["W-1", "ready-to-merge", 3 * HOUR, at("03-05", "13:00")],
      ["W-2", "awaiting-validation", 2 * HOUR, null],
      ["W-1", "blocked", 20 * MIN, at("03-05", "09:20")],
    ]);
  });
});

describe("across projects", () => {
  test("tickets are told apart by project, and percentiles take every project's", () => {
    const i = insights(
      records({ events: [claim("W-1", at("03-05", "08:00")), merge("W-1", at("03-05", "09:00"))] }),
      records({ project: "gadgets", events: [claim("W-1", at("03-05", "08:00")), merge("W-1", at("03-05", "11:00"))] }),
    );
    expect(i.merged.tickets.map((t) => t.project).sort()).toEqual(["gadgets", "widgets"]);
    expect(i.cycle.p90).toBe(3 * HOUR);
  });
});

describe("the overview's summary", () => {
  test("this week's merges, their median, the change from last week", () => {
    const i = insights(
      records({
        events: [
          claim("W-1", at("03-05", "08:00")),
          merge("W-1", at("03-05", "09:40")),
          merge("W-2", at("03-06")),
          merge("W-3", at("03-07")),
          merge("W-9", at("03-01")),
          merge("W-8", at("02-28")),
        ],
      }),
    );
    expect(insightsSummary(i)).toEqual({ merged: 3, previous: 2, change: 0.5, cycleP50: 100 * MIN });
    expect(insightsSummary(insights(records())).change).toBeNull();
  });
});
