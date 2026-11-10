import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/lib/events.ts";
import {
  ACK_MAX,
  attentionOf,
  boardState,
  buildBoard,
  expiryView,
  type FleetRow,
  fleetRow,
  groupByWorkItem,
  isRecoverableReason,
  parseBoardView,
  preview,
  readAcks,
  repositoryLabel,
  summarizeEvents,
  type TurnSummary,
  workItemOf,
  writeAcks,
} from "../src/lib/fleet.ts";
import { outcomeView } from "../src/lib/outcome.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const turn = (status: TurnSummary["status"], reason: string | null = null): TurnSummary => ({
  status,
  reason,
  message: null,
});

describe("summarizeEvents", () => {
  test("takes the latest turn's status and reason and the latest agent message", () => {
    const events: ChatEvent[] = [
      { id: "1", at: 1, kind: "prompt", text: "First", status: "finished", promptId: "p1" },
      { id: "2", at: 2, kind: "message", text: "Done with the first.", partial: false, tools: [], promptId: "p1" },
      { id: "3", at: 3, kind: "prompt", text: "Second", status: "running", promptId: "p2" },
      { id: "4", at: 4, kind: "message", text: "", partial: false, tools: [{ id: "t", name: "Bash" }], promptId: "p2" },
      { id: "5", at: 5, kind: "prompt", text: "", status: "failed", reason: "usage_limit", promptId: "p2" },
    ];
    expect(summarizeEvents(events)).toEqual({
      status: "failed",
      reason: "usage_limit",
      message: "Done with the first.",
      promptId: "p2",
      prompt: { text: "Second", conversationId: null },
      launch: "First",
      startedAt: 3,
      activity: null,
    });
  });

  test("is running while any turn is in flight, and empty before the first", () => {
    expect(summarizeEvents([]).status).toBeNull();
    const events: ChatEvent[] = [
      { id: "1", at: 1, kind: "prompt", text: "A", status: "queued", promptId: "a", conversationId: "c1" },
      { id: "2", at: 2, kind: "prompt", text: "B", status: "finished", promptId: "b", conversationId: "c2" },
    ];
    expect(summarizeEvents(events).status).toBe("running");
  });

  test("joins streamed deltas into one message", () => {
    const delta = (id: string, text: string): ChatEvent => ({
      id,
      at: 1,
      kind: "message",
      text,
      partial: true,
      tools: [],
      messageId: "m",
      textMode: "delta",
    });
    expect(summarizeEvents([delta("1", "Hel"), delta("2", "lo")]).message).toBe("Hello");
  });
});

describe("boardState", () => {
  test("a failed sandbox or turn is failed, with the known explanation", () => {
    expect(boardState("failed", turn("failed", "usage_limit"))).toMatchObject({
      kind: "failed",
      failure: { title: "Usage limit reached" },
    });
    expect(boardState("running", turn("failed", "something odd"))).toMatchObject({
      kind: "failed",
      failure: { title: "something odd", hint: null },
    });
    expect(
      boardState("failed", null, { statusReason: null, lifecycleError: "The provider lost the machine." }).failure
        ?.title,
    ).toBe("The provider lost the machine.");
    // The reason the server recorded on the sandbox explains a launch failure, with its fix.
    expect(boardState("failed", null, { statusReason: "auth_expiry", lifecycleError: "later" }).failure).toEqual({
      title: "Account expired",
      hint: expect.any(String),
      fix: { href: "/harness", label: "Reconnect the account" },
    });
    expect(boardState("failed", null).failure?.title).toBe("Sandbox failed");
  });

  test("a live machine reads its latest turn", () => {
    expect(boardState("running", turn("running")).kind).toBe("working");
    expect(boardState("ready", turn("finished")).kind).toBe("finished");
    expect(boardState("ready", turn("interrupted")).kind).toBe("interrupted");
    expect(boardState("ready", turn(null))).toMatchObject({ kind: "idle", label: "Waiting for a prompt" });
    expect(boardState("starting", turn("finished"))).toMatchObject({ kind: "working", label: "Starting" });
  });

  test("a reported outcome refines a settled turn, live or stopped, but never a turn in flight or a failure", () => {
    const ready = outcomeView({ state: "ready", prNumber: 7 });
    const blocked = outcomeView({ state: "blocked", reason: "Needs a staging key" });
    expect(boardState("ready", turn("finished"), undefined, ready)).toMatchObject({
      kind: "ready",
      label: "Ready to merge",
      outcome: { pr: { label: "PR #7" } },
    });
    expect(boardState("running", null, undefined, blocked)).toMatchObject({ kind: "blocked", label: "Blocked" });
    expect(boardState("stopped", null, undefined, ready).kind).toBe("ready");
    expect(boardState("running", turn("running"), undefined, ready).kind).toBe("working");
    expect(boardState("ready", turn("failed", "usage_limit"), undefined, ready).kind).toBe("failed");
    expect(boardState("failed", null, undefined, ready).kind).toBe("failed");
    expect(boardState("stopping", null, undefined, ready).kind).toBe("stopped");
  });

  test("without events a live machine is shown from its status, and a stopped one is stopped", () => {
    expect(boardState("running", null).kind).toBe("working");
    expect(boardState("ready", null)).toMatchObject({ kind: "idle", label: "Ready" });
    expect(boardState("stopped", turn("finished")).kind).toBe("stopped");
    expect(boardState("stopping", null)).toMatchObject({ kind: "stopped", label: "Stopping" });
  });
});

describe("expiryView", () => {
  test("formats the time left and highlights the last half hour", () => {
    expect(expiryView("running", "2026-11-10T14:05:00.000Z", NOW)).toEqual({
      text: "2 h 5 min left",
      urgent: false,
      seconds: 7500,
    });
    expect(expiryView("ready", "2026-11-10T12:29:59.000Z", NOW)).toMatchObject({ text: "29 min left", urgent: true });
    expect(expiryView("ready", "2026-11-10T12:30:00.000Z", NOW)?.urgent).toBe(false);
    expect(expiryView("running", "2026-11-10T11:00:00.000Z", NOW)).toMatchObject({
      text: "Past deadline",
      urgent: true,
    });
  });

  test("says nothing for a stopped machine or a missing deadline", () => {
    expect(expiryView("stopped", "2026-11-10T12:10:00.000Z", NOW)).toBeNull();
    expect(expiryView("running", null, NOW)).toBeNull();
    expect(expiryView("running", "not a date", NOW)).toBeNull();
  });
});

describe("preview", () => {
  test("keeps a short message whole and cuts a long one at a word", () => {
    expect(preview("  Short\n message ")).toEqual({ text: "Short message", truncated: false });
    const cut = preview("word ".repeat(100), 22);
    expect(cut).toEqual({ text: "word word word word…", truncated: true });
  });
});

describe("repositoryLabel", () => {
  const config = {
    repos: [
      { url: "https://github.com/acme/web.git", branch: "main", dir: "web" },
      { url: "https://github.com/acme/api.git", branch: "develop", dir: "api" },
    ],
    init: [],
  };
  test("names the repository context, the only repository, or how many there are", () => {
    expect(repositoryLabel(config, "api")).toBe("acme/api @ develop");
    expect(repositoryLabel(config, null)).toBe("2 repositories");
    expect(repositoryLabel({ repos: [config.repos[0]], init: [] }, null)).toBe("acme/web @ main");
    expect(repositoryLabel({ nope: true }, null)).toBeNull();
  });
});

describe("fleetRow", () => {
  test("joins the sandbox, its golden and its events", () => {
    const row = fleetRow(
      {
        id: "s1",
        status: "ready",
        harness: "claude",
        model: "claude-opus",
        created_at: "2026-11-10T10:00:00.000Z",
        owner_id: "u1",
        provider_sandbox_id: "bx_one",
        expires_at: "2026-11-10T12:20:00.000Z",
        repository_dir: "web",
      } as Parameters<typeof fleetRow>[0],
      {
        name: "acme",
        config: { repos: [{ url: "git@github.com:acme/web.git", branch: "main", dir: "web" }], init: [] },
      },
      { status: "finished", reason: null, message: "All green." },
      "u2",
      NOW,
    );
    expect(row).toMatchObject({
      name: "bx_one",
      golden: "acme",
      repository: "acme/web @ main",
      mine: false,
      state: { kind: "finished" },
      expiry: { text: "20 min left", urgent: true },
      message: "All green.",
      eventsRead: true,
      preservation: null,
    });
  });

  test("reads the reported outcome and a stopped sandbox's preservation receipt off the row", () => {
    const row = fleetRow(
      {
        id: "s2",
        status: "stopped",
        harness: "codex",
        model: null,
        created_at: "2026-11-10T10:00:00.000Z",
        owner_id: "u1",
        provider_sandbox_id: "bx_two",
        task_outcome: { state: "blocked", reason: "Waiting for the API key" },
        preservation_note:
          "unpushed work preserved at work_recovery:00000000-0000-4000-8000-000000000032/00000000-0000-4000-8000-000000000099",
      } as Parameters<typeof fleetRow>[0],
      null,
      null,
      "u1",
      NOW,
    );
    expect(row.state).toMatchObject({ kind: "blocked", outcome: { reason: "Waiting for the API key" } });
    expect(row.preservation).toEqual({
      kind: "preserved",
      text: "Unpushed work preserved",
      command: "armada recovery s2 > armada-recovery.json",
    });
  });
});

const BOX_MOVED = "The box moved to a new machine while this prompt was running. Send it again.";

describe("honest failures", () => {
  test("a recoverable interruption is an interruption to resend, never a failure", () => {
    expect(isRecoverableReason(BOX_MOVED)).toBe(true);
    expect(isRecoverableReason("The turn was interrupted.")).toBe(true);
    expect(isRecoverableReason("The provider restarted.")).toBe(true);
    expect(isRecoverableReason("usage_limit")).toBe(false);
    expect(isRecoverableReason("The harness exited unexpectedly (code 137).")).toBe(false);
    expect(boardState("ready", turn("failed", BOX_MOVED))).toMatchObject({
      kind: "interrupted",
      failure: null,
      interruption: BOX_MOVED,
    });
    expect(boardState("failed", null, { statusReason: BOX_MOVED, lifecycleError: null }).kind).toBe("interrupted");
  });

  test("a failed sandbox stays a failure, whatever stop the server recorded, unless only interrupted", () => {
    const crash = { statusReason: "The harness exited unexpectedly.", lifecycleError: null };
    expect(boardState("failed", turn("failed", "crash"), crash).kind).toBe("failed");
    expect(boardState("failed", turn("finished"), crash).kind).toBe("failed");
    const ready = outcomeView({ state: "ready", prNumber: 7 });
    expect(boardState("failed", turn("finished"), crash, ready)).toMatchObject({ kind: "failed", outcome: ready });
    expect(boardState("failed", turn("failed", "crash"), crash, ready).outcome).toBeUndefined();
    // A failed turn followed by one that finished on a live machine is history.
    expect(boardState("ready", turn("finished")).kind).toBe("finished");
    const launch = {
      statusReason: "Launch interrupted before completion; provider cleanup is retried until confirmed.",
      lifecycleError: null,
    };
    const state = boardState("failed", null, launch);
    expect(state.kind).toBe("interrupted");
    // Nothing can be resent to an ended sandbox: it needs the operator only for work it preserved.
    expect(attentionOf(state, "failed", null, null, null)).toBeNull();
  });
});

describe("attentionOf", () => {
  const preserved = { kind: "preserved" as const, text: "Unpushed work preserved", command: null };
  test("names what each state needs, and nothing for work in progress or a concluded stop", () => {
    const of = (
      state: ReturnType<typeof boardState>,
      status: Parameters<typeof boardState>[0],
      t: TurnSummary | null,
    ) => attentionOf(state, status, t, null, null);
    expect(of(boardState("ready", turn("finished")), "ready", turn("finished"))).toBe("unconcluded");
    expect(of(boardState("ready", turn("failed", BOX_MOVED)), "ready", turn("failed", BOX_MOVED))).toBe("interrupted");
    expect(of(boardState("running", turn("running")), "running", turn("running"))).toBeNull();
    expect(of(boardState("ready", turn(null)), "ready", turn(null))).toBeNull();
    expect(of(boardState("stopped", turn("finished")), "stopped", turn("finished"))).toBeNull();
    const working = boardState("running", turn("running"));
    expect(
      attentionOf(working, "running", turn("running"), expiryView("running", "2026-11-10T12:10:00.000Z", NOW), null),
    ).toBe("expiring");
    // Stopped mid-turn with its work preserved: the operator decides what happens to it.
    const stopped = boardState("stopped", turn("interrupted"));
    expect(attentionOf(stopped, "stopped", turn("interrupted"), null, preserved)).toBe("unconcluded");
    expect(attentionOf(stopped, "stopped", turn("interrupted"), null, null)).toBeNull();
    // Events that could not be read cannot show the turn concluded.
    expect(attentionOf(boardState("stopped", null), "stopped", null, null, preserved)).toBe("unconcluded");
    expect(
      attentionOf(boardState("stopped", turn("finished")), "stopped", turn("finished"), null, preserved),
    ).toBeNull();
  });
});

describe("workItemOf", () => {
  test("reads the issue or pull request the launch names, else the outcome's pull request", () => {
    expect(workItemOf("Deliver issue #801 in acme/web.", null, "acme/web")).toEqual({
      key: "acme/web#801",
      label: "acme/web#801",
      href: "https://github.com/acme/web/issues/801",
    });
    expect(workItemOf("Fix https://github.com/Acme/API/pull/12 please", null, "acme/web")?.key).toBe("acme/api#12");
    expect(workItemOf("Look at acme/api#7 first", null, null)?.label).toBe("acme/api#7");
    expect(workItemOf("Improve the README", { prUrl: "https://github.com/acme/web/pull/805" }, null)?.key).toBe(
      "acme/web#805",
    );
    expect(workItemOf("Improve the README", { prNumber: 9 }, "acme/web")?.key).toBe("acme/web#9");
    // A number without its repository names nothing: #12 in two repositories is two work items.
    expect(workItemOf("Improve the README", { prNumber: 9 }, null)).toBeNull();
    expect(workItemOf("Deliver issue #12.", null, null)).toBeNull();
    expect(workItemOf("Deliver issue #12, see https://github.com/acme/api/pull/3.", null, null)?.key).toBe(
      "acme/api#3",
    );
    // The first reference names the work; a link given later as context does not.
    expect(workItemOf("Deliver issue #801; context: https://github.com/acme/api/pull/3", null, "acme/web")?.key).toBe(
      "acme/web#801",
    );
    expect(workItemOf("Improve the README", null, "acme/web")).toBeNull();
    expect(workItemOf(null, null, "acme/web")).toBeNull();
  });
});

describe("acknowledgements", () => {
  const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.0a1b2c3d`;
  test("are the viewer's own, bounded, and can be taken back", () => {
    const one = writeAcks(undefined, "u1", key(1));
    expect(readAcks(one, "u1")).toEqual([key(1)]);
    expect(readAcks(one, "u2")).toEqual([]);
    expect(readAcks(writeAcks(one, "u1", key(1), true), "u1")).toEqual([]);
    // Another viewer on the same browser starts from nothing.
    expect(readAcks(writeAcks(one, "u2", key(2)), "u2")).toEqual([key(2)]);
    let many: string | undefined;
    for (let n = 1; n <= ACK_MAX + 5; n++) many = writeAcks(many, "u1", key(n));
    const kept = readAcks(many, "u1");
    expect(kept).toHaveLength(ACK_MAX);
    expect(kept[0]).toBe(key(6));
    expect(many?.length).toBeLessThan(4000);
    expect(readAcks("u1|not-a-key,../x", "u1")).toEqual([]);
  });
});

describe("parseBoardView", () => {
  test("defaults to Needs you", () => {
    expect(parseBoardView(undefined)).toBe("needs-you");
    expect(parseBoardView("needs-me")).toBe("needs-you");
    expect(parseBoardView("all")).toBe("all");
    expect(parseBoardView(["all", "x"])).toBe("all");
  });
});

/** The production board #801 was written from: a busy org's last thirty hours. */
describe("buildBoard on a busy organization", () => {
  const golden = {
    name: "web",
    config: { repos: [{ url: "https://github.com/acme/web.git", branch: "main", dir: "web" }], init: [] },
  };
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  const summary = (fields: Partial<TurnSummary>): TurnSummary => ({
    status: null,
    reason: null,
    message: null,
    ...fields,
  });
  const work = (issue: number) => `Deliver issue #${issue} in acme/web.`;
  let n = 0;
  const row = (
    fields: Partial<Parameters<typeof fleetRow>[0]> & { status: Parameters<typeof fleetRow>[0]["status"] },
    t: TurnSummary | null,
  ): FleetRow =>
    fleetRow(
      {
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        harness: "claude",
        model: null,
        created_at: at(1),
        owner_id: "u1",
        provider_sandbox_id: `bx_${n}`,
        ...fields,
      } as Parameters<typeof fleetRow>[0],
      golden,
      t,
      "u1",
      NOW,
    );

  function busy(): FleetRow[] {
    const rows: FleetRow[] = [];
    // 175 stopped sandboxes that finished: nothing left for the operator.
    for (let i = 0; i < 175; i++)
      rows.push(
        row({ status: "stopped", stopped_at: at(i / 7), created_at: at(i / 7 + 1) }, summary({ status: "finished" })),
      );
    // Three live agents.
    rows.push(
      row(
        { status: "running", created_at: at(1) },
        summary({ status: "running", launch: work(812), activity: "Bash: bun test" }),
      ),
    );
    rows.push(row({ status: "running", created_at: at(2) }, summary({ status: "running", launch: work(813) })));
    const ready = row(
      {
        status: "ready",
        created_at: at(2),
        task_outcome: { state: "ready", prNumber: 805, prUrl: "https://github.com/acme/web/pull/805" },
      },
      summary({ status: "finished", launch: work(801), message: "PR #805 is green." }),
    );
    rows.push(ready);
    // Five "box moved" interruptions: two relaunched on the same issue, two resent and finished, one waiting.
    rows.push(
      row(
        { status: "stopped", created_at: at(20), stopped_at: at(10) },
        summary({ status: "failed", reason: BOX_MOVED, launch: work(801) }),
      ),
    );
    rows.push(
      row(
        { status: "running", created_at: at(20) },
        summary({ status: "failed", reason: BOX_MOVED, launch: work(812) }),
      ),
    );
    rows.push(
      row(
        { status: "stopped", created_at: at(20), stopped_at: at(10) },
        summary({ status: "finished", launch: work(790) }),
      ),
    );
    rows.push(
      row(
        { status: "stopped", created_at: at(20), stopped_at: at(10) },
        summary({ status: "finished", launch: work(791) }),
      ),
    );
    const waiting = row(
      { status: "ready", created_at: at(3) },
      summary({
        status: "failed",
        reason: BOX_MOVED,
        launch: work(811),
        prompt: { text: work(811), conversationId: null },
      }),
    );
    rows.push(waiting);
    // The night's harness crashes: relaunched since, or stopped by the operator.
    const crash = { status_reason: "The harness exited unexpectedly (code 137)." };
    rows.push(
      row(
        { status: "failed", created_at: at(26), ...crash },
        summary({ status: "failed", reason: "crash", launch: work(813) }),
      ),
    );
    rows.push(
      row(
        { status: "failed", created_at: at(26), stopped_at: at(25), ...crash },
        summary({ status: "failed", reason: "crash", launch: work(801) }),
      ),
    );
    // The interrupted launch already reconciled and stopped.
    rows.push(
      row(
        {
          status: "failed",
          created_at: at(15),
          stopped_at: at(15),
          status_reason: "Launch interrupted before completion; provider cleanup is retried until confirmed.",
        },
        null,
      ),
    );
    return rows;
  }

  test("the 175 stopped rows are not on the board and the five box moves are not failures", () => {
    const board = buildBoard(busy(), new Set());
    expect(board.all.filter((item) => item.status === "stopped")).toHaveLength(0);
    expect(board.all.some((item) => item.attention === "failed")).toBe(false);
    expect(board.needs.map((item) => [item.workItem?.label, item.attention])).toEqual([
      ["acme/web#801", "ready"],
      ["acme/web#811", "interrupted"],
    ]);
    const interrupted = board.needs[1];
    expect(interrupted?.resend).toEqual({ text: work(811), conversationId: null });
    expect(interrupted?.state.failure).toBeNull();
    // The relaunch of #801 replaces its box-moved run; #812's live run replaces its earlier interruption.
    expect(board.needs[0]?.replaced).toBe(1);
    expect(board.working.map((item) => [item.workItem?.label, item.replaced])).toEqual([
      ["acme/web#813", 1],
      ["acme/web#812", 1],
    ]);
  });

  test("an acknowledged row leaves Needs you but stays in All, until its state changes", () => {
    const rows = busy();
    const ready = buildBoard(rows, new Set()).needs[0] as FleetRow;
    const board = buildBoard(rows, new Set([ready.ackKey]));
    expect(board.needs.map((item) => item.attention)).toEqual(["interrupted"]);
    expect(board.all.find((item) => item.id === ready.id)?.dismissed).toBe(true);
    // A new turn on the same sandbox is a new key: it needs the operator again.
    const next = row(
      { status: "ready", created_at: ready.createdAt },
      summary({ status: "finished", launch: work(801), promptId: "p2" }),
    );
    expect(next.ackKey).not.toBe(ready.ackKey);
  });

  test("an empty Needs you still counts the agents working", () => {
    const board = buildBoard(
      [row({ status: "running" }, summary({ status: "running" })), row({ status: "stopped", stopped_at: at(1) }, null)],
      new Set(),
    );
    expect(board.needs).toEqual([]);
    expect(board.working).toHaveLength(1);
    expect(board.all).toHaveLength(1);
  });

  test("a newer run that holds nothing does not hide one that does", () => {
    const ready = row(
      { status: "ready", created_at: at(3), task_outcome: { state: "ready", prNumber: 5 } },
      summary({ status: "finished", launch: work(900) }),
    );
    const done = row(
      { status: "stopped", created_at: at(1), stopped_at: at(0.5) },
      summary({ status: "finished", launch: work(900) }),
    );
    expect(buildBoard([ready, done], new Set()).needs.map((item) => item.id)).toEqual([ready.id]);
  });

  test("grouping keeps rows without a work item apart", () => {
    const a = row({ status: "running" }, summary({ status: "running" }));
    const b = row({ status: "running" }, summary({ status: "running" }));
    expect(groupByWorkItem([a, b])).toHaveLength(2);
  });
});
