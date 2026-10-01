import { describe, expect, test } from "bun:test";
import type { InFlightTicket } from "../src/status.ts";
import { coordinatorTrack, type HistoryEvent, sessionTimeline } from "../src/timeline.ts";
import type { AgentPhase, Comment } from "../src/types.ts";

const NOW = new Date("2026-03-04T12:00:00Z");
const at = (t: string) => `2026-03-04T${t}:00.000Z`;
/** The day before NOW. */
const eve = (t: string) => `2026-03-03T${t}:00.000Z`;

let n = 0;
const status = (time: string, phase: AgentPhase, summary = `${phase} at ${time}`): Comment => ({
  id: `c${++n}`,
  issueId: "W-1",
  author: "Worker",
  createdAt: time.includes("T") ? time : at(time),
  excerpt: "",
  status: { phase, summary },
  claim: null,
});
const claim = (time: string): Comment => ({
  ...status(time, "planning"),
  status: null,
  claim: { runtime: "Conductor", session: "ws/1", branch: null, startedAt: at(time), at: at(time), author: "Worker" },
});
/** A claim comment as `armada claim` posts it: a planning status line and the claim. */
const claimed = (time: string): Comment => ({ ...claim(time), status: { phase: "planning", summary: "claimed" } });
const event = (time: string, kind: string, phase: string | null = null, message: string | null = null) =>
  ({ ticket: "W-1", kind, phase, message, at: time.includes("T") ? time : at(time) }) satisfies HistoryEvent;

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

  test("only the last 24 hours: older phases, reports and silences are left out", () => {
    const t = timeline(row({ since: at("05:00"), lastReport: at("11:55") }), [
      claim(eve("06:00")),
      status(eve("07:00"), "awaiting-approval"),
      status(eve("08:00"), "implementing"),
      status(eve("09:00"), "implementing"),
      status(eve("12:30"), "implementing"),
      status(at("05:00"), "implementing"),
      status(at("11:55"), "implementing"),
    ]);
    expect(t.phases.map((s) => [s.phase, s.from])).toEqual([["implementing", eve("08:00")]]);
    expect(t.reports).toEqual([eve("12:30"), at("05:00"), at("11:55")]);
    // The one crossing the window's start stays; the one before it goes.
    expect(t.silences).toEqual([
      { from: eve("09:00"), to: eve("12:30") },
      { from: eve("12:30"), to: at("05:00") },
      { from: at("05:00"), to: at("11:55") },
    ]);
    expect(t.startedAt).toBe(eve("06:00"));
  });

  test("THE-742's shape: status lines left on the ticket before its claim are not part of the run", () => {
    // Two agents left input on the ticket the day before, as status lines, without a claim or a release.
    const t = timeline(
      row({ phase: "shipping", since: at("11:54"), lastReport: at("11:54"), lastUpdate: at("11:54") }),
      [
        status(eve("10:27"), "planning", "lead from another campaign (not a claim)"),
        status(eve("13:52"), "planning", "input from another ticket (not a claim)"),
        claimed("11:42"),
        status("11:48", "implementing", "plan (pre-approved)"),
        status("11:51", "implementing", "running make check"),
        status("11:54", "shipping", "PR open"),
      ],
      [event("11:42", "claim", "planning", "claimed")],
    );
    expect(t.silences).toEqual([]);
    expect(t.startedAt).toBe(at("11:42"));
    expect(t.phases.map((s) => [s.phase, s.from, s.to])).toEqual([
      ["planning", at("11:42"), at("11:48")],
      ["implementing", at("11:48"), at("11:54")],
      ["shipping", at("11:54"), null],
    ]);
    expect(t.reports).toEqual([at("11:42"), at("11:48"), at("11:51"), at("11:54")]);
  });

  test("an old run, a release, then a new claim: the history starts at the new claim", () => {
    const t = timeline(
      row({ phase: "implementing", since: at("11:10"), lastReport: at("11:20"), lastUpdate: at("11:20") }),
      [claim(eve("20:00")), status(eve("21:00"), "implementing"), claimed("11:00"), status("11:10", "implementing")],
      [event(eve("23:00"), "release"), event("11:00", "claim", "planning"), event("11:20", "report", "implementing")],
    );
    expect(t.silences).toEqual([]);
    expect(t.startedAt).toBe(at("11:00"));
    expect(t.phases.map((s) => [s.phase, s.from])).toEqual([
      ["planning", at("11:00")],
      ["implementing", at("11:10")],
    ]);
  });

  test("a silence going on now starts at the claim at the earliest", () => {
    const t = timeline(
      row({ phase: "planning", since: at("11:00"), silent: true, lastReport: eve("13:00"), lastUpdate: eve("13:00") }),
      [status(eve("13:00"), "planning"), claimed("11:00")],
    );
    expect(t.silences).toEqual([{ from: at("11:00"), to: null }]);
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

describe("a coordinator's inbox reads", () => {
  const read = (time: string, id = ++n) => ({ id, at: time.includes("T") ? time : at(time), handle: null });
  const track = (reads: ReturnType<typeof read>[]) => coordinatorTrack({ reads, silentAfterMinutes: 15, now: NOW });

  test("reads closer than a minute are one span; a lone read is a span of its own", () => {
    const watching = ["10:00:00", "10:00:15", "10:00:30", "10:00:45", "10:01:00", "10:01:15"].map((t) =>
      read(`2026-03-04T${t}.000Z`),
    );
    expect(track([...watching, read("10:05"), read("10:09")]).reads).toEqual([
      { from: at("10:00"), to: "2026-03-04T10:01:15.000Z", count: 6 },
      { from: at("10:05"), to: at("10:05"), count: 1 },
      { from: at("10:09"), to: at("10:09"), count: 1 },
    ]);
  });

  test("a gap longer than the silence threshold is idle; a shorter one is not", () => {
    const t = track([read("09:00"), read("09:10"), read("10:00"), read("2026-03-04T10:00:30.000Z")]);
    expect(t.idle).toEqual([{ from: at("09:10"), to: at("10:00") }]);
  });

  test("only the last 24 hours, a gap crossing its start kept", () => {
    const t = track([read(eve("10:00")), read(eve("11:00")), read("11:00")]);
    expect(t.reads.map((r) => r.from)).toEqual([at("11:00")]);
    expect(t.idle).toEqual([{ from: eve("11:00"), to: at("11:00") }]);
  });
});
