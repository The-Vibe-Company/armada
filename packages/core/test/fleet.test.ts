import { describe, expect, test } from "bun:test";
import { buildLane, frontier, inFlight } from "../src/fleet.ts";
import { buildModel } from "../src/model.ts";
import type { Comment, Issue } from "../src/types.ts";
import { issue } from "./support.ts";

const program = (...children: Issue[]) =>
  buildModel(
    [issue("P-1", { title: "Program" }), ...children.map((c) => ({ ...c, parentId: c.parentId ?? "P-1" }))],
    "P-1",
  );

const ids = (xs: { issue: Issue }[]) => xs.map((x) => x.issue.id);

const labels = { ready: "ready-for-agent", parked: "parked" };

describe("frontier", () => {
  test("a ticket is ready when it is not started and every blocked-by ticket is closed", () => {
    const m = program(
      issue("P-2", { statusType: "completed" }),
      issue("P-3", { statusType: "canceled" }),
      issue("P-4", {
        blockedBy: [
          { id: "P-2", statusType: "completed" },
          { id: "P-3", statusType: "canceled" },
        ],
      }),
      issue("P-5", { statusType: "started" }),
      issue("P-6", { blockedBy: [{ id: "P-5", statusType: "started" }] }),
      issue("P-7", { statusType: "unstarted" }),
      issue("P-8", { statusType: "triage" }),
    );
    expect(ids(frontier(m, labels)).sort()).toEqual(["P-4", "P-7", "P-8"]);
  });

  test("a blocker outside the program counts by the state recorded on the relation", () => {
    const m = program(
      issue("P-2", { blockedBy: [{ id: "EXT-1", statusType: "started" }] }),
      issue("P-3", { blockedBy: [{ id: "EXT-2", statusType: "completed" }] }),
    );
    expect(ids(frontier(m, labels))).toEqual(["P-3"]);
  });

  test("tickets held by an agent, with an open PR, or with sub-issues are not on the frontier", () => {
    const m = program(
      issue("P-2", { agentPhase: "planning" }),
      issue("P-3", { prs: [{ url: "u", number: 1, repo: "a/b", title: "", state: "open" }] }),
      issue("P-4"),
      issue("P-5", { parentId: "P-4" }),
    );
    expect(ids(frontier(m, labels))).toEqual(["P-5"]);
  });

  test("a ticket carrying the configured parked label is off the frontier, ready label or not", () => {
    const m = program(
      issue("P-2", { labels: ["parked"] }),
      issue("P-3", { labels: ["ready-for-agent", "parked"] }),
      issue("P-4", { labels: ["on-hold"] }),
    );
    expect(ids(frontier(m, labels))).toEqual(["P-4"]);
    // The label name is configuration: another one parks, and "parked" stops doing so.
    expect(ids(frontier(m, { ready: "ready-for-agent", parked: "on-hold" })).sort()).toEqual(["P-2", "P-3"]);
  });

  test("ranking puts the ready label first, then what a ticket unlocks", () => {
    const m = program(
      issue("P-2"),
      issue("P-3", { blockedBy: [{ id: "P-2", statusType: "backlog" }] }),
      issue("P-4", { labels: ["ready-for-agent"] }),
      issue("P-5", { labels: ["ready-for-agent"], statusType: "triage" }),
    );
    const ranked = frontier(m, labels);
    expect(ranked.map((c) => [c.issue.id, c.readyForAgent, c.unlocksAll])).toEqual([
      ["P-4", true, []],
      ["P-2", false, ["P-3"]],
      ["P-5", false, []],
    ]);
  });
});

const comment = (issueId: string, at: string, body: Partial<Comment>): Comment => ({
  id: `${issueId}-${at}`,
  issueId,
  author: "Worker",
  createdAt: at,
  excerpt: "",
  status: null,
  claim: null,
  ...body,
});

describe("lanes", () => {
  const opts = { now: Date.parse("2026-03-04T10:00:00Z"), silentAfterMinutes: 15 };
  const lane = (i: Issue, comments: Comment[] = []) => buildLane(program(i), comments, i, opts);

  test("shipping stages prefer the current report, survive snapshot refresh, and fall back to PR checks", () => {
    const pr = { url: "u", number: 3, repo: "a/b", title: "", state: "open" as const };
    const i = issue("P-2", { statusType: "started", agentPhase: "shipping", prs: [pr] });
    expect(lane(i).shippingStage).toBe("review");
    expect(lane({ ...i, prs: [] }).shippingStage).toBeNull();
    for (const ci of ["pending", "failure", "success"] as const)
      expect(lane({ ...i, prs: [{ ...pr, ci }] }).shippingStage).toBe("ci");
    const report = {
      kind: "report",
      phase: "shipping",
      shippingStage: "review" as const,
      message: "review",
      at: "2026-03-04T09:58:00Z",
    };
    const read = (after: string, changes = {}) =>
      buildLane(
        program(i),
        [],
        { ...i, ...changes },
        {
          ...opts,
          live: { after, events: { "P-2": report } },
        },
      );
    for (const after of ["2026-03-04T09:57:00Z", "2026-03-04T09:59:00Z"])
      expect(read(after, { prs: [{ ...pr, ci: "pending" }] }).shippingStage).toBe("review");
    expect(read("2026-03-04T09:59:00Z", { agentPhase: "implementing" }).shippingStage).toBeNull();
    expect(
      buildLane(
        program(i),
        [],
        { ...i, prs: [{ ...pr, ci: "pending" }] },
        {
          ...opts,
          live: {
            after: "2026-03-04T09:59:00Z",
            events: { "P-2": { ...report, kind: "claim" } },
          },
        },
      ).shippingStage,
    ).toBe("review");
    const replaced = buildLane(program(i), [], i, {
      ...opts,
      live: {
        after: "2026-03-04T09:59:00Z",
        events: { "P-2": report },
        handles: { "P-2": { runtime: "Conductor", handle: "new", claimedAt: "2026-03-04T09:59:00Z" } },
      },
    });
    expect(replaced.shippingStage).toBe("review"); // From the PR, rather than the prior worker's explicit review.
    expect(
      buildLane(
        program(i),
        [],
        { ...i, prs: [{ ...pr, ci: "pending" }] },
        {
          ...opts,
          live: {
            after: "2026-03-04T09:59:00Z",
            events: { "P-2": report },
            handles: { "P-2": { runtime: "Conductor", handle: "new", claimedAt: "2026-03-04T09:59:00Z" } },
          },
        },
      ).shippingStage,
    ).toBe("ci");
  });

  test("the phase label wins over the latest status line, which wins over inference", () => {
    const statusLine = comment("P-2", "2026-03-04T09:55:00Z", { status: { phase: "shipping", summary: "PR open" } });
    const labelled = issue("P-2", { statusType: "started", agentPhase: "implementing" });
    expect(lane(labelled, [statusLine])).toMatchObject({ phase: "implementing", phaseSource: "label" });
    const unlabelled = issue("P-2", { statusType: "started" });
    expect(lane(unlabelled, [statusLine])).toMatchObject({ phase: "shipping", phaseSource: "status-line" });
    const withGreenPr = issue("P-2", {
      statusType: "started",
      prs: [{ url: "u", number: 3, repo: "a/b", title: "", state: "open", ci: "success", mergeable: "MERGEABLE" }],
    });
    expect(lane(withGreenPr)).toMatchObject({ phase: "ready-to-merge", phaseSource: "inferred" });
  });

  test("a merged PR on an open ticket shows as merged unless the label says work restarted", () => {
    const merged = [{ url: "u", number: 3, repo: "a/b", title: "", state: "merged" as const }];
    const shipped = issue("P-2", { statusType: "started", agentPhase: "ready-to-merge", prs: merged });
    expect(lane(shipped).phase).toBe("merged");
    const restarted = issue("P-2", { statusType: "started", agentPhase: "implementing", prs: merged });
    expect(lane(restarted).phase).toBe("implementing");
  });

  test("silence counts from the last report, never while the worker waits on a human", () => {
    const at = (t: string) => `2026-03-04T${t}:00Z`;
    const report = (t: string) => comment("P-2", at(t), { status: { phase: "implementing", summary: "" } });
    // Edits and chatter after the last report are not reports.
    const working = issue("P-2", { statusType: "started", agentPhase: "implementing", updatedAt: at("09:58") });
    const chatter = comment("P-2", at("09:55"), {});
    expect(lane(working, [report("09:30"), chatter]).flags).toContain("silent");
    expect(lane(working, [report("09:50")]).flags).not.toContain("silent");
    const withEvent = buildLane(program(working), [report("09:30")], working, {
      ...opts,
      lastEvents: { "P-2": at("09:52") },
    });
    expect(withEvent.lastReport).toBe(at("09:52"));
    expect(withEvent.flags).not.toContain("silent");
    const withHeartbeat = buildLane(program(working), [report("09:00")], working, {
      ...opts,
      heartbeats: { "P-2": at("09:58") },
    });
    expect(withHeartbeat.lastReport).toBe(at("09:00"));
    expect(withHeartbeat.lastHeartbeat).toBe(at("09:58"));
    expect(withHeartbeat.flags).not.toContain("silent");
    expect(
      buildLane(program(working), [report("09:55")], working, {
        ...opts,
        heartbeats: { "P-2": at("09:30") },
      }).flags,
    ).not.toContain("silent");
    expect(
      buildLane(program(working), [report("09:55")], working, {
        ...opts,
        now: Date.parse(at("10:11")),
        heartbeats: { "P-2": at("09:30") },
      }).flags,
    ).toContain("silent");
    const resumed = buildLane(program(working), [report("09:00")], working, {
      ...opts,
      live: {
        after: at("09:50"),
        events: { "P-2": { kind: "report", phase: "implementing", message: "resumed", at: at("09:55") } },
        handles: { "P-2": { runtime: "Conductor", handle: "workspace/session", lastHeartbeatAt: at("09:30") } },
      },
    });
    expect(resumed.flags).not.toContain("silent");
    const waiting = issue("P-2", { statusType: "started", agentPhase: "awaiting-approval", updatedAt: at("09:00") });
    expect(lane(waiting, [report("09:00")]).flags).not.toContain("silent");
    // A lane that never reported falls back to its last sign of life.
    expect(lane(working).flags).not.toContain("silent");
    const stale = issue("P-2", { statusType: "started", agentPhase: "implementing", updatedAt: at("09:30") });
    expect(lane(stale).flags).toContain("silent");
  });

  test("two claims since the last release flag a double claim; a release clears older claims", () => {
    const claim = (at: string, session: string) =>
      comment("P-2", at, { claim: { runtime: "Codex", session, branch: null, startedAt: null, at, author: null } });
    const released = comment("P-2", "2026-03-04T09:05:00Z", { status: { phase: "released", summary: "" } });
    const i = issue("P-2", { statusType: "started", agentPhase: "planning", assignee: "Worker" });
    const a = claim("2026-03-04T09:00:00Z", "one");
    const b = claim("2026-03-04T09:10:00Z", "two");
    expect(lane(i, [a, b]).flags).toContain("double-claim");
    const afterRelease = lane(i, [a, released, b]);
    expect(afterRelease.flags).not.toContain("double-claim");
    expect(afterRelease.claim?.session).toBe("two");
  });

  test("time in phase starts at the first report of the current phase, not at the latest repeat", () => {
    const report = (at: string, phase: "planning" | "implementing") =>
      comment("P-2", at, { status: { phase, summary: "" } });
    const i = issue("P-2", { statusType: "started", agentPhase: "implementing" });
    const l = lane(i, [
      report("2026-03-04T09:45:00Z", "implementing"),
      report("2026-03-04T09:30:00Z", "implementing"),
      report("2026-03-04T09:10:00Z", "planning"),
      report("2026-03-04T08:50:00Z", "implementing"),
    ]);
    expect(l.since).toBe("2026-03-04T09:30:00Z");
  });

  test("a live report newer than the tracker read wins the phase, the time in phase and the status", () => {
    const i = issue("P-2", { statusType: "started", agentPhase: "implementing", assignee: "Worker" });
    const announced = comment("P-2", "2026-03-04T09:00:00Z", { status: { phase: "implementing", summary: "coding" } });
    const report = { kind: "report", phase: "shipping", message: "PR open", at: "2026-03-04T09:58:00Z" };
    const withLive = (after: string) =>
      buildLane(program(i), [announced], i, { ...opts, live: { after, events: { "P-2": report } } });

    expect(withLive("2026-03-04T09:57:00Z")).toMatchObject({
      phase: "shipping",
      phaseSource: "live",
      since: "2026-03-04T09:58:00Z",
      lastReport: "2026-03-04T09:58:00Z",
      statusLine: { summary: "PR open", at: "2026-03-04T09:58:00Z" },
    });
    // The tracker was read after the report: its label already says what the report said.
    expect(withLive("2026-03-04T09:59:00Z")).toMatchObject({ phase: "implementing", phaseSource: "label" });
  });
});

describe("tickets in flight", () => {
  const opts = { now: Date.parse("2026-03-04T10:00:00Z"), silentAfterMinutes: 15 };
  const after = "2026-03-04T09:50:00Z";
  const event = (kind: string, phase: string | null, at: string) => ({ kind, phase, message: null, at });

  test("a claim after the tracker read puts a ticket in flight; a release or a merge takes one out", () => {
    const m = program(
      issue("P-2", { labels: ["ready-for-agent"] }),
      issue("P-3", { statusType: "started", agentPhase: "implementing" }),
      issue("P-4", { statusType: "started", agentPhase: "implementing" }),
      issue("P-5", { statusType: "started", agentPhase: "ready-to-merge" }),
    );
    const lanes = inFlight(m, [], {
      ...opts,
      live: {
        after,
        events: {
          "P-2": event("claim", "planning", "2026-03-04T09:55:00Z"),
          "P-3": event("release", null, "2026-03-04T09:56:00Z"),
          "P-4": event("release", null, "2026-03-04T09:40:00Z"),
          "P-5": event("merge", "merged", "2026-03-04T09:57:00Z"),
        },
        handles: { "P-2": { runtime: "Conductor", handle: "ws-1/s-1" } },
      },
    });
    expect(lanes.map((l) => [l.issue.id, l.phase, l.runtime, l.handle, l.flags])).toEqual([
      ["P-4", "implementing", null, null, ["silent", "no-assignee"]],
      ["P-2", "planning", "Conductor", "ws-1/s-1", []],
    ]);
    expect(lanes.find((l) => l.issue.id === "P-2")?.since).toBe("2026-03-04T09:55:00Z");
  });
});
