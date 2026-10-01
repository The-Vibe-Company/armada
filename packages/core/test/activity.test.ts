import { describe, expect, test } from "bun:test";
import { type ActivityInput, agentActivity } from "../src/activity.ts";
import type { LatestEvent, StoredInboxItem } from "../src/live.ts";
import type { Comment } from "../src/types.ts";

const at = (t: string) => `2026-03-04T${t}:00.000Z`;

const comment = (id: string, time: string, over: Partial<Comment> = {}): Comment => ({
  id,
  issueId: "ABC-7",
  author: "Worker A",
  createdAt: at(time),
  excerpt: "",
  status: null,
  claim: null,
  ...over,
});

const event = (kind: LatestEvent["kind"], time: string, over: Partial<LatestEvent> = {}): LatestEvent => ({
  kind,
  phase: null,
  message: null,
  runtime: null,
  handle: null,
  prUrl: null,
  at: at(time),
  ...over,
});

const item = (id: number, kind: StoredInboxItem["kind"], time: string, over: Partial<StoredInboxItem> = {}) =>
  ({
    id,
    project: "acme",
    ticket: "ABC-7",
    kind,
    recipient: "coordinator",
    author: "Worker A",
    body: `body ${id}`,
    createdAt: at(time),
    resolvedAt: null,
    resolution: null,
    ...over,
  }) satisfies StoredInboxItem;

const input = (over: Partial<ActivityInput>): ActivityInput => ({
  comments: [],
  events: [],
  inbox: [],
  launches: [],
  prs: [],
  ...over,
});

describe("agentActivity", () => {
  test("a run from launch to hand-back, newest first, each report once", () => {
    const activity = agentActivity(
      input({
        launches: [{ at: at("08:58"), by: "Dana Owner" }],
        events: [
          event("claim", "09:00", { runtime: "Conductor", handle: "ws-1/ses-2", phase: "planning" }),
          event("report", "09:30", { phase: "implementing", message: "writing the parser" }),
          event("report", "09:45", { phase: "implementing", message: "tests pass locally" }),
        ],
        comments: [
          comment("c1", "09:00", {
            status: { phase: "planning", summary: "claimed" },
            claim: {
              runtime: "Conductor",
              session: "ws-1/ses-2",
              branch: "feature/abc-7",
              startedAt: at("09:00"),
              profile: "opus",
              at: at("09:00"),
              author: "Worker A",
            },
          }),
          // The same report as the 09:30 event, recorded on Linear a moment later.
          comment("c2", "09:31", { status: { phase: "implementing", summary: "writing the parser" } }),
          // A report only Linear has (the live data was down).
          comment("c3", "10:10", { status: { phase: "ready-to-merge", summary: "PR #12 green" } }),
          comment("c4", "10:20", { author: "Dana Owner", excerpt: "Thanks, merging after lunch." }),
        ],
        inbox: [item(1, "hand-back", "10:10", { body: "PR #12 is ready" })],
        prs: [{ number: 12, createdAt: at("09:50") }],
      }),
    );
    expect(activity.map((a) => [a.kind, a.at.slice(11, 16)])).toEqual([
      ["comment", "10:20"],
      ["hand-back", "10:10"],
      ["phase", "10:10"],
      ["pr", "09:50"],
      ["report", "09:45"],
      ["phase", "09:30"],
      ["branch", "09:00"],
      ["claim", "09:00"],
      ["launch", "08:58"],
    ]);
    const claim = activity.find((a) => a.kind === "claim");
    expect(claim).toMatchObject({ handle: "ws-1/ses-2", branch: "feature/abc-7", profile: "opus", author: "Worker A" });
    expect(activity.find((a) => a.kind === "launch")?.author).toBe("Dana Owner");
    expect(activity.find((a) => a.at === at("09:30"))).toMatchObject({
      phase: "implementing",
      text: "writing the parser",
      author: "Worker A",
    });
    expect(activity.find((a) => a.kind === "pr")?.pr).toBe(12);
  });

  test("a question and a plan show with their answers, and the owner's requests with their state", () => {
    const activity = agentActivity(
      input({
        inbox: [
          item(1, "question", "09:10", { resolvedAt: at("09:20"), resolution: "15 minutes" }),
          item(2, "plan", "09:30"),
          item(3, "release-request", "09:40", { author: "Dana Owner", body: "Release ABC-7" }),
          item(4, "merge-request", "09:50", {
            author: "Dana Owner",
            request: { question: null, profile: null, pr: 12 },
            resolvedAt: at("09:55"),
          }),
        ],
      }),
    );
    expect(activity.map((a) => a.kind)).toEqual(["request", "request", "plan", "answer", "question"]);
    expect(activity.find((a) => a.kind === "answer")?.text).toBe("15 minutes");
    expect(activity.find((a) => a.kind === "question")?.resolvedAt).toBe(at("09:20"));
    expect(activity.find((a) => a.kind === "plan")?.resolvedAt).toBeNull();
    expect(activity.filter((a) => a.kind === "request").map((a) => [a.request, a.pr, a.resolvedAt])).toEqual([
      ["merge-request", 12, at("09:55")],
      ["release-request", null, null],
    ]);
  });

  test("a claim without live data comes from its comment; release and merge events show", () => {
    const activity = agentActivity(
      input({
        comments: [
          comment("c1", "09:00", {
            claim: {
              runtime: "Codex",
              session: null,
              branch: null,
              startedAt: null,
              at: at("09:00"),
              author: "Worker B",
            },
          }),
        ],
        events: [event("release", "11:00", { message: "superseded" }), event("merge", "12:00")],
      }),
    );
    expect(activity.map((a) => a.kind)).toEqual(["merge", "release", "claim"]);
    expect(activity.find((a) => a.kind === "claim")).toMatchObject({ runtime: "Codex", branch: null });
    expect(activity.find((a) => a.kind === "release")?.text).toBe("superseded");
  });
});
