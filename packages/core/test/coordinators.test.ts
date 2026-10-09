import { expect, test } from "bun:test";
import { strandedOwners } from "../src/coordinators.ts";
import type { CoordinatorRecord } from "../src/live.ts";
import { NOW } from "./support.ts";

test("stranded owners have tickets and are other roles silent beyond twice the configured interval", () => {
  const role = (name: string, ageMinutes: number, tickets = ["DEMO-11"]): CoordinatorRecord => ({
    name,
    tickets,
    seenAt: new Date(NOW.getTime() - ageMinutes * 60_000).toISOString(),
    startedAt: NOW.toISOString(),
    inboxSeenAt: null,
    harness: null,
    handle: null,
    model: null,
    cliVersion: null,
    sessions: [],
  });
  const old = role("old", 120, ["DEMO-11", "DEMO-18"]);
  const records = [
    old,
    role("default", 120),
    role("recent", 29),
    role("boundary", 30),
    role("empty", 120, []),
    role("future", -1),
    { ...role("invalid", 120), seenAt: "invalid" },
  ];
  expect(strandedOwners(records, "default", 15, NOW)).toEqual([old]);
  expect(strandedOwners(records, "old", 15, NOW).map((r) => r.name)).toEqual(["default"]);
  expect(strandedOwners(records, "default", 60, NOW)).toEqual([]);
});
