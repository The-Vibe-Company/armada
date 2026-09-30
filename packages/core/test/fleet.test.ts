import { describe, expect, test } from "bun:test";
import { buildLane, frontier } from "../src/fleet.ts";
import { buildModel } from "../src/model.ts";
import type { Comment, Issue } from "../src/types.ts";
import { issue } from "./support.ts";

const program = (...children: Issue[]) =>
  buildModel(
    [issue("P-1", { title: "Program" }), ...children.map((c) => ({ ...c, parentId: c.parentId ?? "P-1" }))],
    "P-1",
  );

const ids = (xs: { issue: Issue }[]) => xs.map((x) => x.issue.id);

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
    expect(ids(frontier(m, "ready-for-agent")).sort()).toEqual(["P-4", "P-7", "P-8"]);
  });

  test("a blocker outside the program counts by the state recorded on the relation", () => {
    const m = program(
      issue("P-2", { blockedBy: [{ id: "EXT-1", statusType: "started" }] }),
      issue("P-3", { blockedBy: [{ id: "EXT-2", statusType: "completed" }] }),
    );
    expect(ids(frontier(m, "ready-for-agent"))).toEqual(["P-3"]);
  });

  test("tickets held by an agent, with an open PR, or with sub-issues are not on the frontier", () => {
    const m = program(
      issue("P-2", { agentPhase: "planning" }),
      issue("P-3", { prs: [{ url: "u", number: 1, repo: "a/b", title: "", state: "open" }] }),
      issue("P-4"),
      issue("P-5", { parentId: "P-4" }),
    );
    expect(ids(frontier(m, "ready-for-agent"))).toEqual(["P-5"]);
  });

  test("ranking puts the ready label first, then what a ticket unlocks", () => {
    const m = program(
      issue("P-2"),
      issue("P-3", { blockedBy: [{ id: "P-2", statusType: "backlog" }] }),
      issue("P-4", { labels: ["ready-for-agent"] }),
      issue("P-5", { labels: ["ready-for-agent"], statusType: "triage" }),
    );
    const ranked = frontier(m, "ready-for-agent");
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

  test("a working agent with no update past the threshold is silent; one waiting on a human is not", () => {
    const old = "2026-03-04T09:30:00Z";
    const working = issue("P-2", { statusType: "started", agentPhase: "implementing", updatedAt: old });
    const waiting = issue("P-2", { statusType: "started", agentPhase: "awaiting-approval", updatedAt: old });
    const fresh = issue("P-2", { statusType: "started", agentPhase: "implementing", updatedAt: old });
    expect(lane(working).flags).toContain("silent");
    expect(lane(waiting).flags).not.toContain("silent");
    expect(lane(fresh, [comment("P-2", "2026-03-04T09:50:00Z", {})]).flags).not.toContain("silent");
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
});
