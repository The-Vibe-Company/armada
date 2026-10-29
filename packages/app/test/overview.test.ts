import { expect, test } from "bun:test";
import { fleetItems, groupCounts, groupItems, headline, rowTime, subline } from "../src/fleet/overview";
import { sessionsInFlight } from "../src/fleet/sessions";
import { readFleetState } from "../src/fleet/state";

// Synthetic folded states, in the shape the daemon's fold sends (packages/daemon/src/fold.ts).
const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const session = (ticket: string, state: string, phase: string, extra: Record<string, unknown> = {}) => ({
  ticket,
  session: `s-${ticket}`,
  generation: 1,
  owner: "default",
  runtime: "local",
  handle: `h-${ticket}`,
  title: `Title of ${ticket}`,
  phase,
  state,
  reason: phase,
  step: 0,
  flowStep: "implementing",
  at: "2026-03-10T09:00:00.000Z",
  heartbeat: null,
  ...extra,
});
const pr = (ticket: string, number: number, extra: Record<string, unknown> = {}) => ({
  number,
  ticket,
  state: "open",
  ci: "success",
  conflicting: false,
  head: `h${number}`,
  ...extra,
});

test("reads every session of the fold into the five states, with V1's reasons and steps", () => {
  const state = readFleetState({
    sessions: [
      session("EX-1", "in-progress", "implementing", { reason: "Wiring the feed\nmore detail" }),
      session("EX-2", "blocked", "implementing", { reason: "ignored: the question wins" }),
      session("EX-3", "blocked", "shipping", { flowStep: "ci" }),
      session("EX-4", "blocked", "shipping", { flowStep: "review" }),
      session("EX-5", "blocked", "blocked", { reason: "Waiting for a key" }),
      session("EX-6", "waiting-for-owner", "awaiting-approval", { flowStep: "plan" }),
      session("EX-7", "waiting-for-owner", "awaiting-validation"),
      session("EX-8", "ready-to-merge", "ready-to-merge", { flowStep: "ci" }),
      session("EX-9", "ready-to-merge", "ready-to-merge", { flowStep: "ci" }),
      session("EX-10", "merged", "merged", { flowStep: "merged", at: "2026-03-10T11:00:00.000Z" }),
      session("EX-11", "merged", "merged", { flowStep: "merged", at: "2026-03-09T11:00:00.000Z" }),
      session("EX-12", "released", "released"),
      session("EX-13", "in-progress", "planning", { flowStep: "plan" }),
      session("EX-14", "merged", "merged", { flowStep: "merged", at: "2026-03-10T14:00:00.000Z" }),
      { ticket: "EX-15", state: "blocked" },
    ],
    pullRequests: [
      pr("EX-3", 30, { ci: "failure" }),
      pr("EX-4", 40, { conflicting: true }),
      pr("EX-8", 80),
      pr("EX-10", 100, { state: "merged" }),
    ],
    inbox: [{ id: "q", ticket: "EX-2", kind: "question", body: "\nSunrise or a fixed hour?\n\nOptions:\n- sunrise" }],
    queue: [{ id: "m", ticket: "EX-9", session: "s-EX-9", pr: 90, head: "h", at: "", seq: 1, state: "queued" }],
    validations: [
      {
        id: "v",
        ticket: "EX-7",
        session: "s-EX-7",
        question: "Does the amber read at night?\nDetails",
        checks: [],
        decision: null,
      },
    ],
  });
  const items = fleetItems([{ id: "orchard", state }], { now: NOW, zone: "UTC" });
  expect(items.map((i) => [i.ticket, i.group, i.reason, i.step])).toEqual([
    ["EX-1", "running", "Wiring the feed", 2],
    ["EX-2", "blocked", "Unanswered question: Sunrise or a fixed hour?", 2],
    ["EX-3", "blocked", "Red CI on #30", 3],
    ["EX-4", "blocked", "Conflict with main on #40", 3],
    ["EX-5", "blocked", "Blocked: Waiting for a key", 2],
    ["EX-6", "you", "Plan to approve", 1],
    ["EX-7", "you", "Does the amber read at night?", 2],
    ["EX-8", "ready", "Handed back · #80 green", 4],
    ["EX-9", "ready", "Queued in the merge queue (position 1)", 4],
    // A reason that only repeats the phase is no line of the worker's.
    ["EX-13", "running", "At work", 0],
    // Merged on the viewer's day, newest first; yesterday's, the released one and an unreadable row are left out.
    ["EX-14", "merged", "Merged", 6],
    ["EX-10", "merged", "#100 merged", 6],
  ]);
  expect(items[0]?.key).toBe("orchard/EX-1");
  expect(groupItems(items).map((g) => [g.group, g.items.length])).toEqual([
    ["blocked", 4],
    ["you", 2],
    ["running", 2],
    ["ready", 2],
    ["merged", 2],
  ]);
  const n = groupCounts(items);
  expect(headline(n)).toBe("4 agents blocked, 2 waiting for your decision.");
  expect(subline(n, 1)).toEqual([
    "10 agents in flight across 1 project",
    "2 moving on their own",
    "2 ready to merge",
    "2 merged today",
  ]);
  expect(sessionsInFlight(state)).toBe(10);
});

test("merged today is the viewer's day, and a row's time is the hour today, else the date", () => {
  const state = readFleetState({
    sessions: [session("EX-1", "merged", "merged", { flowStep: "merged", at: "2026-03-09T23:30:00.000Z" })],
  });
  // 23:30 UTC on the 9th is the 10th in Paris.
  expect(fleetItems([{ id: "o", state }], { now: NOW, zone: "UTC" })).toEqual([]);
  expect(fleetItems([{ id: "o", state }], { now: NOW, zone: "Europe/Paris" }).map((i) => i.ticket)).toEqual(["EX-1"]);
  expect(rowTime("2026-03-10T09:05:00.000Z", NOW, "UTC")).toBe("09:05");
  expect(rowTime("2026-03-08T09:05:00.000Z", NOW, "UTC")).toBe("8 Mar");
  expect(rowTime("2026-03-10T09:05:00.000Z", NOW, "Not/AZone")).toBe("09:05");
});

test("the headline says nothing blocked, and when nothing waits", () => {
  const zero = { blocked: 0, you: 0, running: 3, ready: 0, merged: 0 };
  expect(headline(zero)).toBe("Everything is moving, nothing is waiting.");
  expect(headline({ ...zero, you: 1 })).toBe("Nothing blocked. 1 waiting for your decision.");
  expect(headline({ ...zero, blocked: 1 })).toBe("1 agent blocked, nothing waits for your decision.");
});

test("a state of another shape reads as an empty fleet", () => {
  for (const shape of [null, [], "text", { sessions: "none" }]) expect(readFleetState(shape).sessions).toEqual([]);
});
