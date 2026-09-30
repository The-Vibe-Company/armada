import { describe, expect, test } from "bun:test";
import { buildOverview, type ProjectReading, pipeline } from "../src/overview.ts";
import type { InFlightTicket, StatusReport } from "../src/status.ts";
import type { InboxItem } from "../src/turso.ts";

const NOW = new Date("2026-03-04T10:00:00Z");
const at = (t: string) => `2026-03-04T${t}:00.000Z`;

const ticket = (id: string, over: Partial<InFlightTicket> = {}): InFlightTicket => ({
  id,
  title: `Title of ${id}`,
  url: `https://linear.app/acme/issue/${id}`,
  spec: null,
  phase: "implementing",
  phaseSource: "label",
  runtime: "Conductor",
  handle: null,
  profile: null,
  agent: "Worker",
  since: at("09:00"),
  lastUpdate: at("09:55"),
  lastReport: at("09:55"),
  silent: false,
  statusLine: null,
  pr: null,
  openBlockers: [],
  flags: [],
  ...over,
});

const report = (slug: string, inFlight: InFlightTicket[]): StatusReport => ({
  schemaVersion: 1,
  generatedAt: NOW.toISOString(),
  project: { name: slug, slug, repository: `acme/${slug}` },
  programRoot: { id: "R-1", title: "Root", url: "u" },
  sources: { linear: { fetchedAt: NOW.toISOString() }, github: { fetchedAt: null, error: null } },
  silentAfterMinutes: 15,
  inFlight,
  frontier: [],
  pullRequests: [],
  warnings: [],
});

let id = 0;
const item = (over: Partial<InboxItem>): InboxItem => ({
  id: ++id,
  project: "widgets",
  ticket: null,
  kind: "question",
  recipient: "coordinator",
  author: "Worker",
  body: "",
  createdAt: at("09:00"),
  ...over,
});

const reading = (slug: string, inFlight: InFlightTicket[], live: ProjectReading["live"]): ProjectReading => ({
  slug,
  name: slug,
  repository: `acme/${slug}`,
  report: report(slug, inFlight),
  error: null,
  live,
});

describe("fleet overview", () => {
  test("one waiting list across projects, one reason per ticket, most urgent kind first", () => {
    const widgets = reading(
      "widgets",
      [
        ticket("W-1", { phase: "blocked", since: at("09:30") }),
        ticket("W-2", { phase: "ready-to-merge", since: at("09:20") }),
        ticket("W-3", { silent: true, lastReport: at("09:10") }),
        ticket("W-4"),
      ],
      {
        inbox: [
          item({ ticket: "W-1", body: "Which table?", createdAt: at("09:31") }),
          item({ ticket: "W-2", kind: "hand-back", body: "PR #4 green", createdAt: at("09:21") }),
          item({ ticket: "W-4", kind: "request", body: "launch" }),
          item({ ticket: "W-4", recipient: "worker", body: "use the view" }),
        ],
        coordinatorSeenAt: at("09:50"),
      },
    );
    const gadgets = reading("gadgets", [ticket("G-1", { phase: "awaiting-approval", since: at("08:00") })], {
      inbox: [],
      coordinatorSeenAt: at("09:00"),
    });
    const o = buildOverview({ projects: [widgets, gadgets], live: { state: "ok", error: null }, now: NOW });

    expect(o.waiting.map((w) => [w.kind, w.project, w.ticket, w.detail])).toEqual([
      ["question", "widgets", "W-1", "Which table?"],
      ["approval", "gadgets", "G-1", null],
      ["hand-back", "widgets", "W-2", "PR #4 green"],
      ["silent", "widgets", "W-3", null],
    ]);
    expect(o.rows.map((r) => [r.id, r.waiting, r.question?.body ?? null])).toEqual([
      ["W-1", "question", "Which table?"],
      ["G-1", "approval", null],
      ["W-2", "hand-back", null],
      ["W-3", "silent", null],
      ["W-4", null, null],
    ]);
    expect(o.projects.map((p) => [p.slug, p.coordinator.state, p.inFlight, p.waiting])).toEqual([
      ["widgets", "active", 4, 3],
      ["gadgets", "idle", 1, 1],
    ]);
  });

  test("without Turso the waiting list comes from the tracker and the coordinator is unknown", () => {
    const o = buildOverview({
      projects: [reading("widgets", [ticket("W-1", { phase: "ready-to-merge" })], null)],
      live: { state: "unreachable", error: "timeout" },
      now: NOW,
    });
    expect(o.waiting.map((w) => [w.kind, w.ticket])).toEqual([["hand-back", "W-1"]]);
    expect(o.projects[0]?.coordinator).toEqual({ state: "unknown", seenAt: null });
  });

  test("the pipeline places each phase on its step and marks what needs someone", () => {
    const pr = (ci: "success" | "failure" | "pending" | null, mergeable: string | null = "MERGEABLE") => ({
      number: 1,
      url: "u",
      title: "",
      draft: false,
      ci,
      mergeable,
    });
    const at = (t: Partial<InFlightTicket>) => pipeline(ticket("W-1", t));
    expect(at({ phase: "planning" })).toEqual({ step: 0, state: "ok" });
    expect(at({ phase: "awaiting-approval" })).toEqual({ step: 1, state: "wait" });
    expect(at({ phase: "shipping", pr: pr(null) })).toEqual({ step: 3, state: "ok" });
    expect(at({ phase: "shipping", pr: pr("failure") })).toEqual({ step: 4, state: "fail" });
    expect(at({ phase: "ready-to-merge", pr: pr("success", "CONFLICTING") })).toEqual({ step: 5, state: "fail" });
    expect(at({ phase: "blocked" })).toEqual({ step: 1, state: "fail" });
  });
});
