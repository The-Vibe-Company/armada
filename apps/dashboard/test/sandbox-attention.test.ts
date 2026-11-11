import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../src/lib/events.ts";
import { outcomeView } from "../src/lib/outcome.ts";
import {
  ACK_MAX,
  attentionOf,
  attentionState,
  expiryView,
  isRecoverableReason,
  readAcks,
  sandboxAttention,
  summarizeEvents,
  type TurnSummary,
  writeAcks,
} from "../src/lib/sandbox-attention.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const BOX_MOVED = "The box moved to a new machine while this prompt was running. Send it again.";
const turn = (status: TurnSummary["status"], reason: string | null = null): TurnSummary => ({
  status,
  reason,
});

describe("summarizeEvents", () => {
  test("keeps the latest turn's prompt, status and reason", () => {
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
      promptId: "p2",
      prompt: { text: "Second", conversationId: null },
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
});

describe("attentionState", () => {
  test("a failed sandbox or turn is failed, with the known explanation", () => {
    expect(attentionState("failed", turn("failed", "usage_limit"))).toMatchObject({
      kind: "failed",
      failure: { title: "Usage limit reached" },
    });
    expect(attentionState("running", turn("failed", "something odd"))).toMatchObject({
      kind: "failed",
      failure: { title: "something odd", hint: null },
    });
    expect(
      attentionState("failed", null, { statusReason: null, lifecycleError: "The provider lost the machine." }).failure
        ?.title,
    ).toBe("The provider lost the machine.");
    // The reason the server recorded on the sandbox explains a launch failure, with its fix.
    expect(attentionState("failed", null, { statusReason: "auth_expiry", lifecycleError: "later" }).failure).toEqual({
      title: "Account expired",
      hint: expect.any(String),
      fix: { href: "/harness", label: "Reconnect the account" },
    });
    expect(attentionState("failed", null).failure?.title).toBe("Sandbox failed");
  });

  test("a live machine reads its latest turn", () => {
    expect(attentionState("running", turn("running")).kind).toBe("working");
    expect(attentionState("ready", turn("finished")).kind).toBe("finished");
    expect(attentionState("ready", turn("interrupted")).kind).toBe("interrupted");
    expect(attentionState("ready", turn(null))).toMatchObject({ kind: "idle", label: "Waiting for a prompt" });
    expect(attentionState("starting", turn("finished"))).toMatchObject({ kind: "working", label: "Starting" });
  });

  test("a reported outcome refines a settled turn, live or stopped, but never a turn in flight or a failure", () => {
    const ready = outcomeView({ state: "ready", prNumber: 7 });
    const blocked = outcomeView({ state: "blocked", reason: "Needs a staging key" });
    expect(attentionState("ready", turn("finished"), undefined, ready)).toMatchObject({
      kind: "ready",
      label: "Ready to merge",
      outcome: { pr: { label: "PR #7" } },
    });
    expect(attentionState("running", null, undefined, blocked)).toMatchObject({ kind: "blocked", label: "Blocked" });
    expect(attentionState("stopped", null, undefined, ready).kind).toBe("ready");
    expect(attentionState("running", turn("running"), undefined, ready).kind).toBe("working");
    expect(attentionState("ready", turn("failed", "usage_limit"), undefined, ready).kind).toBe("failed");
    expect(attentionState("failed", null, undefined, ready).kind).toBe("failed");
    expect(attentionState("stopping", null, undefined, ready).kind).toBe("stopped");
  });

  test("without events a live machine is shown from its status, and a stopped one is stopped", () => {
    expect(attentionState("running", null).kind).toBe("working");
    expect(attentionState("ready", null)).toMatchObject({ kind: "idle", label: "Ready" });
    expect(attentionState("stopped", turn("finished")).kind).toBe("stopped");
    expect(attentionState("stopping", null)).toMatchObject({ kind: "stopped", label: "Stopping" });
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

describe("honest failures", () => {
  test("a recoverable interruption is an interruption to resend, never a failure", () => {
    expect(isRecoverableReason(BOX_MOVED)).toBe(true);
    expect(isRecoverableReason("The turn was interrupted.")).toBe(true);
    expect(isRecoverableReason("The provider restarted.")).toBe(true);
    expect(isRecoverableReason("usage_limit")).toBe(false);
    expect(isRecoverableReason("The harness exited unexpectedly (code 137).")).toBe(false);
    expect(attentionState("ready", turn("failed", BOX_MOVED))).toMatchObject({
      kind: "interrupted",
      failure: null,
      interruption: BOX_MOVED,
    });
    expect(attentionState("failed", null, { statusReason: BOX_MOVED, lifecycleError: null }).kind).toBe("interrupted");
  });

  test("a failed sandbox stays a failure, whatever stop the server recorded, unless only interrupted", () => {
    const crash = { statusReason: "The harness exited unexpectedly.", lifecycleError: null };
    expect(attentionState("failed", turn("failed", "crash"), crash).kind).toBe("failed");
    expect(attentionState("failed", turn("finished"), crash).kind).toBe("failed");
    const ready = outcomeView({ state: "ready", prNumber: 7 });
    expect(attentionState("failed", turn("finished"), crash, ready)).toMatchObject({ kind: "failed", outcome: ready });
    expect(attentionState("failed", turn("failed", "crash"), crash, ready).outcome).toBeUndefined();
    // A failed turn followed by one that finished on a live machine is history.
    expect(attentionState("ready", turn("finished")).kind).toBe("finished");
    const launch = {
      statusReason: "Launch interrupted before completion; provider cleanup is retried until confirmed.",
      lifecycleError: null,
    };
    const state = attentionState("failed", null, launch);
    expect(state.kind).toBe("interrupted");
    // Nothing can be resent to an ended sandbox: it needs the operator only for work it preserved.
    expect(attentionOf(state, "failed", null, null, null)).toBeNull();
  });
});

describe("attentionOf", () => {
  const preserved = { kind: "preserved" as const, text: "Unpushed work preserved", command: null };
  test("names what each state needs, and nothing for work in progress or a concluded stop", () => {
    const of = (
      state: ReturnType<typeof attentionState>,
      status: Parameters<typeof attentionState>[0],
      t: TurnSummary | null,
    ) => attentionOf(state, status, t, null, null);
    expect(of(attentionState("ready", turn("finished")), "ready", turn("finished"))).toBe("unconcluded");
    expect(of(attentionState("ready", turn("failed", BOX_MOVED)), "ready", turn("failed", BOX_MOVED))).toBe(
      "interrupted",
    );
    expect(of(attentionState("running", turn("running")), "running", turn("running"))).toBeNull();
    expect(of(attentionState("ready", turn(null)), "ready", turn(null))).toBeNull();
    expect(of(attentionState("stopped", turn("finished")), "stopped", turn("finished"))).toBeNull();
    const working = attentionState("running", turn("running"));
    expect(
      attentionOf(working, "running", turn("running"), expiryView("running", "2026-11-10T12:10:00.000Z", NOW), null),
    ).toBe("expiring");
    // Stopped mid-turn with its work preserved: the operator decides what happens to it.
    const stopped = attentionState("stopped", turn("interrupted"));
    expect(attentionOf(stopped, "stopped", turn("interrupted"), null, preserved)).toBe("unconcluded");
    expect(attentionOf(stopped, "stopped", turn("interrupted"), null, null)).toBeNull();
    // Events that could not be read cannot show the turn concluded.
    expect(attentionOf(attentionState("stopped", null), "stopped", null, null, preserved)).toBe("unconcluded");
    expect(
      attentionOf(attentionState("stopped", turn("finished")), "stopped", turn("finished"), null, preserved),
    ).toBeNull();
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

describe("sandbox attention projection", () => {
  const sandbox = { id: "00000000-0000-4000-8000-000000000030", status: "ready" as const, conversation_ids: ["c1"] };
  test("keeps legacy acknowledgement keys but a new turn needs acknowledgement again", () => {
    const first = sandboxAttention(sandbox, { ...turn("finished"), promptId: "p1" }, NOW);
    expect(first.ackKey).toBe(`${sandbox.id}.382207ad`);
    expect(first.attention).toBe("unconcluded");
    expect(sandboxAttention(sandbox, { ...turn("finished"), promptId: "p2" }, NOW).ackKey).not.toBe(first.ackKey);
  });
  test("resend keeps a recorded conversation and drops an unrecorded native reference", () => {
    for (const [conversationId, expected] of [
      ["c1", "c1"],
      ["native-only", null],
    ] as const) {
      const result = sandboxAttention(
        sandbox,
        { ...turn("failed", BOX_MOVED), prompt: { text: "Resume the work", conversationId } },
        NOW,
      );
      expect(result.resend).toEqual({ text: "Resume the work", conversationId: expected });
    }
  });
});
