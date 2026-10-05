import { describe, expect, test } from "bun:test";
import type { InboxItem } from "../src/live.ts";
import { buildOverview, flowStep, type ProjectReading, pipeline } from "../src/overview.ts";
import type { InFlightTicket, StatusReport } from "../src/status.ts";

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
  coordinatorMinutes: 10,
  inFlight,
  notStarted: [],
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
  test("an approval shows the full plan, its actionable inbox id and any pending answer request", () => {
    const plan = item({ ticket: "W-1", kind: "plan", body: "Build the parser\n\n1. Validate\n2. Test" });
    const answer = item({
      ticket: "W-1",
      kind: "answer-request",
      body: "approved",
      author: "Ada",
      request: { question: plan.id, profile: null },
    });
    const overview = buildOverview({
      projects: [
        reading("widgets", [ticket("W-1", { phase: "awaiting-approval" })], {
          inbox: [plan, answer],
          coordinatorSeenAt: null,
        }),
      ],
      live: { state: "ok", error: null },
      now: NOW,
    });
    expect(overview.waiting).toEqual([
      expect.objectContaining({
        kind: "approval",
        detail: plan.body,
        item: plan.id,
        answer: { id: answer.id, body: "approved", author: "Ada", at: answer.createdAt },
      }),
    ]);
  });

  test("a live worker without a report is not an owner item; silence starts at its newest heartbeat or report", () => {
    const overview = buildOverview({
      projects: [
        reading(
          "widgets",
          [
            ticket("W-1", { lastReport: at("09:00"), lastHeartbeat: at("09:58") }),
            ticket("W-2", { silent: true, lastReport: at("09:00"), lastHeartbeat: at("09:40") }),
            ticket("W-3", { silent: true, lastReport: at("09:40"), lastHeartbeat: at("09:00") }),
          ],
          null,
        ),
      ],
      live: { state: "ok", error: null },
      now: NOW,
    });
    expect(overview.waiting).toEqual([
      expect.objectContaining({ ticket: "W-2", kind: "silent", since: at("09:40") }),
      expect.objectContaining({ ticket: "W-3", kind: "silent", since: at("09:40") }),
    ]);
  });

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
    // Launched, never claimed: no lane, it waits like a silent worker.
    const launched = { ticket: "W-5", launchedAt: at("09:15"), tokenUsedAt: null, handle: "ws-5" };
    if (widgets.report)
      widgets.report.notStarted = [{ ...launched, title: "Parse", url: "u5", detail: "launched 45 min ago" }];
    const gadgets = reading("gadgets", [ticket("G-1", { phase: "awaiting-approval", since: at("08:00") })], {
      inbox: [],
      coordinatorSeenAt: at("09:00"),
    });
    const o = buildOverview({ projects: [widgets, gadgets], live: { state: "ok", error: null }, now: NOW });

    expect(o.waiting.map((w) => [w.kind, w.project, w.ticket, w.detail])).toEqual([
      ["question", "widgets", "W-1", "Which table?"],
      ["approval", "gadgets", "G-1", null],
      ["hand-back", "widgets", "W-2", "PR #4 green"],
      ["not-started", "widgets", "W-5", "launched 45 min ago"],
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
      ["widgets", "active", 4, 4],
      ["gadgets", "idle", 1, 1],
    ]);
  });

  test("an item open in the coordinator's inbox longer than policy.coordinator_minutes waits for the coordinator", () => {
    const tickets = [
      ticket("W-1", { phase: "blocked" }),
      ticket("W-2", { phase: "ready-to-merge" }),
      ticket("W-3", { phase: "awaiting-approval" }),
    ];
    const inbox = [
      item({ ticket: "W-1", body: "Which table?", createdAt: at("09:31") }),
      item({ ticket: "W-2", kind: "hand-back", body: "PR #4 green", createdAt: at("09:55") }),
      // An answer the owner gave from the dashboard, not delivered yet: the plan still waits.
      item({ ticket: "W-3", kind: "plan", body: "Plan", createdAt: at("09:40") }),
      item({ ticket: "W-3", kind: "answer-request", body: "approved", createdAt: at("09:58") }),
    ];
    const waits = (coordinatorMinutes?: number) => {
      const r = reading("widgets", tickets, { inbox, coordinatorSeenAt: at("09:20") });
      if (r.report && coordinatorMinutes) r.report = { ...r.report, coordinatorMinutes };
      return buildOverview({ projects: [r], live: { state: "ok", error: null }, now: NOW }).waiting.map((w) => [
        w.ticket,
        w.coordinatorSince,
      ]);
    };
    expect(waits()).toEqual([
      ["W-1", at("09:31")],
      ["W-3", at("09:40")],
      ["W-2", null],
    ]);
    expect(waits(25)).toEqual([
      ["W-1", at("09:31")],
      ["W-3", null],
      ["W-2", null],
    ]);
    // A project-wide item is late on its own, not since the oldest of them.
    const r = reading("widgets", [], {
      inbox: [item({ body: "Old", createdAt: at("09:30") }), item({ body: "New", createdAt: at("09:58") })],
      coordinatorSeenAt: null,
    });
    expect(
      buildOverview({ projects: [r], live: { state: "ok", error: null }, now: NOW }).waiting.map((w) => [
        w.detail,
        w.coordinatorSince,
      ]),
    ).toEqual([
      ["Old", at("09:30")],
      ["New", null],
    ]);
  });

  test("the owner's requests show as pending on their question and their ready ticket, never as waiting for the owner", () => {
    const frontier = (id: string) => ({
      id,
      title: id,
      url: `u/${id}`,
      spec: null,
      readyForAgent: true,
      onCriticalPath: false,
      unlocks: [],
      route: { profile: "opus", why: "conductor.default_profile" },
      labels: [],
    });
    const question = item({ ticket: "W-1", body: "Which table?" });
    const widgets: ProjectReading = {
      ...reading("widgets", [ticket("W-1", { phase: "blocked" })], {
        inbox: [
          question,
          item({
            ticket: "W-1",
            kind: "answer-request",
            author: "Ada",
            body: "users",
            request: { question: question.id, profile: null },
          }),
          item({
            ticket: "W-8",
            kind: "launch-request",
            author: "Ada",
            body: "Launch W-8",
            request: { question: null, profile: "codex" },
          }),
        ],
        coordinatorSeenAt: null,
      }),
      profiles: { opus: { runtime: "conductor", agent: "claude", model: "opus-5-5", effort: "high", fastMode: false } },
    };
    widgets.report?.frontier.push(frontier("W-8"), frontier("W-9"));
    const o = buildOverview({ projects: [widgets], live: { state: "ok", error: null }, now: NOW });

    const pending = { id: question.id + 1, body: "users", author: "Ada", at: at("09:00") };
    expect(o.waiting.map((w) => [w.kind, w.item, w.answer])).toEqual([["question", question.id, pending]]);
    expect(o.rows[0]?.question?.answer).toEqual(pending);
    expect(o.ready.map((r) => [r.project, r.id, r.route?.profile, r.launch])).toEqual([
      ["widgets", "W-8", "opus", { id: question.id + 2, author: "Ada", at: at("09:00"), profile: "codex" }],
      ["widgets", "W-9", "opus", null],
    ]);
    expect(o.projects[0]?.profiles).toEqual([{ name: "opus", agent: "claude", model: "opus-5-5", effort: "high" }]);
  });

  test("each coordinator's CLI version, and whether a newer one is released", () => {
    const seen = (slug: string, coordinatorCliVersion: string | null) =>
      reading(slug, [], { inbox: [], coordinatorSeenAt: at("09:50"), coordinatorCliVersion });
    const o = buildOverview({
      projects: [seen("widgets", "0.2.1"), seen("gadgets", "0.2.4"), seen("gizmos", null)],
      live: { state: "ok", error: null },
      now: NOW,
      latestCli: "0.2.4",
    });
    expect(o.projects.map((p) => [p.slug, p.coordinator.cliVersion, p.coordinator.updateAvailable])).toEqual([
      ["widgets", "0.2.1", true],
      ["gadgets", "0.2.4", false],
      ["gizmos", null, false],
    ]);
  });

  test("without the live data the waiting list comes from the tracker and the coordinator is unknown", () => {
    const o = buildOverview({
      projects: [reading("widgets", [ticket("W-1", { phase: "ready-to-merge" })], null)],
      live: { state: "unreachable", error: "timeout" },
      now: NOW,
    });
    expect(o.waiting.map((w) => [w.kind, w.ticket])).toEqual([["hand-back", "W-1"]]);
    expect(o.projects[0]?.coordinator).toEqual({
      state: "unknown",
      seenAt: null,
      cliVersion: null,
      updateAvailable: false,
    });
    expect(o.timeline?.coordinators).toEqual([{ project: "widgets", inboxTrack: { reads: [], idle: [] } }]);
  });

  test("each row carries its timeline, drawn from its own comments and events only", () => {
    const widgets: ProjectReading = {
      ...reading("widgets", [ticket("W-1", { since: at("09:30") }), ticket("W-2")], {
        inbox: [],
        coordinatorSeenAt: null,
      }),
      history: {
        comments: [
          {
            id: "c1",
            issueId: "W-1",
            author: "Worker",
            createdAt: at("09:00"),
            excerpt: "",
            status: { phase: "planning", summary: "reading" },
            claim: null,
          },
        ],
        events: [
          { ticket: "W-1", kind: "report", phase: "implementing", message: "started", at: at("09:30") },
          { ticket: "W-2", kind: "report", phase: "implementing", message: "other", at: at("09:40") },
        ],
      },
    };
    const o = buildOverview({ projects: [widgets], live: { state: "ok", error: null }, now: NOW });
    const w1 = o.timeline?.rows.find((r) => r.id === "W-1")?.timeline;
    expect(w1?.phases.map((s) => [s.phase, s.from, s.to])).toEqual([
      ["planning", at("09:00"), at("09:30")],
      ["implementing", at("09:30"), null],
    ]);
    expect(w1?.reports).toEqual([at("09:00"), at("09:30")]);
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

  test("the board's flow places each session in its step, a waiting one in the step it left", () => {
    const pr = (ci: "success" | "pending" | "none" | null) => ({
      number: 1,
      url: "u",
      title: "",
      draft: false,
      ci,
      mergeable: "MERGEABLE",
    });
    const step = (t: Partial<InFlightTicket>, earlier: InFlightTicket["phase"][] = []) =>
      flowStep(ticket("W-1", t), earlier);
    expect(step({ phase: "planning" })).toBe("plan");
    expect(step({ phase: "awaiting-approval" })).toBe("plan");
    expect(step({ phase: "implementing" })).toBe("implementing");
    // The stage the worker reported wins over the pull request's checks.
    expect(step({ phase: "shipping", shippingStage: "review", pr: pr("pending") })).toBe("review");
    expect(step({ phase: "shipping", shippingStage: "ci", pr: pr(null) })).toBe("ci");
    expect(step({ phase: "shipping", pr: pr("none") })).toBe("review");
    expect(step({ phase: "shipping", pr: pr("pending") })).toBe("ci");
    expect(step({ phase: "ready-to-merge", pr: pr("success") })).toBe("ci");
    expect(step({ phase: "merged", pr: pr("success") })).toBe("merged");
    // Blocked or awaiting a validation: the last working phase of its timeline.
    expect(step({ phase: "blocked" }, ["planning", "implementing", "blocked"])).toBe("implementing");
    expect(step({ phase: "blocked", pr: pr("success") }, ["shipping", "blocked"])).toBe("ci");
    expect(step({ phase: "awaiting-validation" }, ["planning", "awaiting-validation"])).toBe("plan");
    // No working phase known: where its pull request is, else the plan.
    expect(step({ phase: "blocked", pr: pr(null) }, ["blocked"])).toBe("review");
    expect(step({ phase: "awaiting-validation" })).toBe("plan");
  });

  test("a blocked row keeps the step its timeline left, and each project carries its last merges", () => {
    const merged = [
      {
        id: "W-9",
        title: "Done",
        url: "https://linear.app/acme/issue/W-9",
        spec: null,
        mergedAt: at("08:00"),
        pr: { number: 9, url: "https://github.com/acme/widgets/pull/9" },
      },
    ];
    const base = reading("widgets", [ticket("W-1", { phase: "blocked", since: at("09:40") })], {
      inbox: [],
      coordinatorSeenAt: null,
    });
    const widgets: ProjectReading = {
      ...base,
      report: base.report ? { ...base.report, merged } : null,
      history: {
        comments: [],
        events: [
          { ticket: "W-1", kind: "claim", phase: "planning", message: null, at: at("09:00") },
          { ticket: "W-1", kind: "report", phase: "implementing", message: "started", at: at("09:20") },
          { ticket: "W-1", kind: "ask", phase: "blocked", message: "which?", at: at("09:40") },
        ],
      },
    };
    const o = buildOverview({ projects: [widgets], live: { state: "ok", error: null }, now: NOW });
    expect(o.rows.map((r) => [r.id, r.step])).toEqual([["W-1", "implementing"]]);
    expect(o.projects[0]?.merged).toEqual(merged);
  });
});

test("the overview carries each project's default-branch health", () => {
  const r = reading("widgets", [], null);
  if (!r.report) throw new Error("missing report fixture");
  r.report.main = {
    branch: "main",
    head: "a".repeat(40),
    state: "red",
    redSince: { sha: "a".repeat(40), pr: 17, at: NOW.toISOString(), failing: ["test"] },
    fixRunning: null,
    redBeyondWindow: false,
  };
  const o = buildOverview({ projects: [r, reading("older", [], null)], live: { state: "ok", error: null }, now: NOW });
  expect(o.projects[0]?.main).toEqual(r.report.main);
  expect(o.projects[1]?.main).toBeNull();
});
