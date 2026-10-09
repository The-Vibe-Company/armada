import { expect, test } from "bun:test";
import type { ProjectOverview, ShownJob } from "@armada/core/read";
import { ticketJobLines } from "../lib/jobs-view.ts";

const NOW = Date.parse("2026-03-11T12:00:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
const job = (over: Partial<ShownJob>): ShownJob => ({
  id: 1,
  project: "widgets",
  ticket: "W-1",
  name: "eval",
  state: "running",
  progress: null,
  eta: null,
  startedAt: at(60),
  observedAt: at(60),
  finishedAt: null,
  overdue: false,
  stalled: false,
  ticketDone: false,
  maxHours: null,
  ...over,
});

test("a ticket's jobs show their progress, ETA, last news and overdue against the injected clock", () => {
  const project = {
    jobs: [
      job({ id: 1, name: "backfill", state: "succeeded", progress: "done", observedAt: at(30), finishedAt: at(30) }),
      job({
        id: 2,
        progress: "37/120 cases",
        eta: at(-80),
        observedAt: at(4),
        maxHours: 12,
        progressChangedAt: at(11),
        stallMinutes: 10,
        silenceMinutes: 5,
      }),
      // Past max_hours, its estimate passed, its ticket closed while it runs on.
      job({ id: 3, name: "replay", startedAt: at(3 * 60 + 1), eta: at(5), maxHours: 3, ticketDone: true }),
      job({ id: 4, ticket: "W-2" }),
    ],
  } as ProjectOverview;

  expect(ticketJobLines(project, "W-1", NOW)).toEqual([
    {
      id: 3,
      name: "replay",
      state: "running",
      open: true,
      progress: null,
      eta: { at: at(5), inMs: -5 * MIN },
      lastNewsMs: 60 * MIN,
      overdue: true,
      stalled: false,
      maxHours: 3,
      ticketDone: true,
    },
    {
      id: 2,
      name: "eval",
      state: "running",
      open: true,
      progress: "37/120 cases",
      eta: { at: at(-80), inMs: 80 * MIN },
      lastNewsMs: 4 * MIN,
      overdue: false,
      stalled: true,
      maxHours: 12,
      ticketDone: false,
    },
    {
      id: 1,
      name: "backfill",
      state: "succeeded",
      open: false,
      progress: "done",
      eta: null,
      lastNewsMs: 30 * MIN,
      overdue: false,
      stalled: false,
      maxHours: null,
      ticketDone: false,
    },
  ]);
  expect(ticketJobLines(project, "W-1", NOW + 2 * MIN).find((j) => j.id === 2)?.stalled).toBe(false);
  expect(ticketJobLines(undefined, "W-1", NOW)).toEqual([]);
});
