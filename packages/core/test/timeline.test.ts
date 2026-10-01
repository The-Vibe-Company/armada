import { describe, expect, test } from "bun:test";
import type { InFlightTicket } from "../src/status.ts";
import { type HistoryEvent, sessionTimeline } from "../src/timeline.ts";
import type { AgentPhase, Comment } from "../src/types.ts";

const NOW = new Date("2026-03-04T12:00:00Z");
const at = (t: string) => `2026-03-04T${t}:00.000Z`;

let n = 0;
const status = (time: string, phase: AgentPhase, summary = `${phase} at ${time}`): Comment => ({
  id: `c${++n}`,
  issueId: "W-1",
  author: "Worker",
  createdAt: at(time),
  excerpt: "",
  status: { phase, summary },
  claim: null,
});
const claim = (time: string): Comment => ({
  ...status(time, "planning"),
  status: null,
  claim: { runtime: "Conductor", session: "ws/1", branch: null, startedAt: at(time), at: at(time), author: "Worker" },
});
const event = (time: string, kind: string, phase: string | null = null, message: string | null = null) =>
  ({ ticket: "W-1", kind, phase, message, at: at(time) }) satisfies HistoryEvent;

type Row = Parameters<typeof sessionTimeline>[0]["ticket"];
const row = (over: Partial<Row> = {}): Row => ({
  phase: "implementing",
  since: at("10:00"),
  lastReport: at("11:50"),
  lastUpdate: at("11:50"),
  silent: false,
  statusLine: null,
  pr: null,
  ...over,
});
const timeline = (ticket: Row, comments: Comment[], events: HistoryEvent[] = []) =>
  sessionTimeline({ ticket, history: { comments, events }, silentAfterMinutes: 15, now: NOW });

describe("a session's timeline", () => {
  test("phases from status comments and events, each report once, the row's phase last", () => {
    const t = timeline(
      row({
        statusLine: {
          summary: "wiring the queue",
          at: at("11:50"),
          url: "u",
          plan: false,
        } as InFlightTicket["statusLine"],
      }),
      [claim("09:00"), status("09:20", "awaiting-approval", "plan posted"), status("10:00", "implementing")],
      // The 10:00 report is also an event, a few seconds later: one report, at the event's time.
      [event("10:00", "report", "implementing", "go"), event("11:50", "report", "implementing", "wiring")],
    );
    expect(t.phases).toEqual([
      { phase: "planning", from: at("09:00"), to: at("09:20"), summary: null },
      { phase: "awaiting-approval", from: at("09:20"), to: at("10:00"), summary: "plan posted" },
      { phase: "implementing", from: at("10:00"), to: null, summary: "wiring the queue" },
    ]);
    expect(t.reports).toEqual([at("09:00"), at("09:20"), at("10:00"), at("11:50")]);
  });

  test("the row's reading wins: a live phase newer than the last comment runs from its since", () => {
    const t = timeline(row({ phase: "shipping", since: at("11:30") }), [
      claim("09:00"),
      status("10:00", "implementing"),
    ]);
    expect(t.phases.map((s) => [s.phase, s.from, s.to])).toEqual([
      ["planning", at("09:00"), at("10:00")],
      ["implementing", at("10:00"), at("11:30")],
      ["shipping", at("11:30"), null],
    ]);
  });

  test("only the current run: what came before the last release is dropped", () => {
    const t = timeline(row({ phase: "planning", since: at("10:30") }), [
      status("08:00", "implementing"),
      status("09:00", "released"),
      claim("10:30"),
    ]);
    expect(t.phases).toEqual([{ phase: "planning", from: at("10:30"), to: null, summary: null }]);
    expect(t.reports).toEqual([at("10:30")]);
  });

  test("silences: gaps longer than the threshold while the worker had to move, and the one going on now", () => {
    const t = timeline(row({ phase: "implementing", since: at("10:00"), silent: true, lastReport: at("11:00") }), [
      claim("08:00"),
      status("08:10", "awaiting-approval"),
      // Waiting for approval for 50 minutes is not a silence.
      status("09:00", "planning"),
      // 45 minutes without a report while planning is one.
      status("09:45", "planning"),
      status("10:00", "implementing"),
      status("11:00", "implementing"),
    ]);
    expect(t.silences).toEqual([
      { from: at("09:00"), to: at("09:45") },
      { from: at("10:00"), to: at("11:00") },
      { from: at("11:00"), to: null },
    ]);
  });

  test("only the last 8 hours: older phases, reports and silences are left out", () => {
    const t = timeline(row({ since: at("05:00"), lastReport: at("11:55") }), [
      claim("01:00"),
      status("02:00", "awaiting-approval"),
      status("05:00", "implementing"),
      status("11:55", "implementing"),
    ]);
    expect(t.phases.map((s) => s.phase)).toEqual(["awaiting-approval", "implementing"]);
    expect(t.reports).toEqual([at("05:00"), at("11:55")]);
    expect(t.silences).toEqual([{ from: at("05:00"), to: at("11:55") }]);
  });

  test("the pull request's opening, long summaries cut short", () => {
    const pr = { number: 4, url: "u", title: "t", draft: false, ci: null, mergeable: null, createdAt: at("11:00") };
    const t = timeline(
      row({ pr, statusLine: { summary: "x".repeat(400), at: at("11:50"), url: "u", plan: false } }),
      [],
    );
    expect(t.prOpenedAt).toBe(at("11:00"));
    expect(t.phases[0]?.summary?.length).toBe(140);
  });
});
