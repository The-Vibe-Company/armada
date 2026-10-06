import { expect, test } from "bun:test";
import type { ProjectOverview } from "@armada/core/read";
import { deployLines, holdLines } from "../lib/holds-view.ts";

const NOW = Date.parse("2026-03-11T12:00:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

test("merge pauses read newest first across projects, and deploy targets carry their state, age and silence", () => {
  const widgets = {
    slug: "widgets",
    name: "Widgets",
    holds: [
      { id: 3, kind: "manual", ref: null, reason: "release freeze", openedBy: "Owner", openedAt: at(90) },
      { id: 7, kind: "deploy", ref: "production", reason: "deployment smoke-failed", openedBy: null, openedAt: at(5) },
    ],
    deploys: [
      { target: "production", last: { sha: "a1", state: "smoke-failed", startedAt: at(20), updatedAt: at(5) } },
      { target: "staging", last: { sha: "b2", state: "waiting", startedAt: at(30), updatedAt: at(12) } },
      { target: "preview", last: { sha: "c3", state: "waiting", startedAt: at(4), updatedAt: at(4) } },
      { target: "docs", last: null },
    ],
  } as ProjectOverview;
  const gadgets = {
    slug: "gadgets",
    name: "Gadgets",
    holds: [{ id: 4, kind: "main-red", ref: "main", reason: "main is red", openedBy: null, openedAt: at(30) }],
  } as ProjectOverview;

  expect(holdLines([widgets, gadgets], NOW).map((h) => [h.project, h.id, h.kind, h.ageMs / MIN])).toEqual([
    ["widgets", 7, "deploy", 5],
    ["gadgets", 4, "main-red", 30],
    ["widgets", 3, "manual", 90],
  ]);
  expect(deployLines(widgets, NOW)).toEqual([
    { target: "production", state: "smoke-failed", sha: "a1", ageMs: 5 * MIN, quiet: false },
    { target: "staging", state: "waiting", sha: "b2", ageMs: 12 * MIN, quiet: true },
    { target: "preview", state: "waiting", sha: "c3", ageMs: 4 * MIN, quiet: false },
    { target: "docs", state: null, sha: null, ageMs: null, quiet: false },
  ]);
  // No `[deploy]`, or live data not read: no Deploys block.
  expect(deployLines(gadgets, NOW)).toBeNull();
});
