import { expect, test } from "bun:test";
import { type AgentEvent, buildEventPage, coalesceEventMessages } from "../src/index.ts";

const message = (
  id: string,
  text: string,
  mode: "delta" | "snapshot" = "delta",
): Extract<AgentEvent, { kind: "message" }> => ({
  id,
  at: 1,
  kind: "message",
  messageId: "m",
  conversationId: "c",
  promptId: "p",
  textMode: mode,
  text,
  partial: true,
  tools: [],
});

test("coalescing respects snapshots, logical identities and non-message boundaries", () => {
  const result = coalesceEventMessages([
    message("1", "stale"),
    message("2", "fresh", "snapshot"),
    message("3", "!"),
    { ...message("4", "other"), messageId: "other" } as AgentEvent,
    { id: "5", at: 1, kind: "other", type: "boundary", data: {} },
    message("6", "new"),
  ]);
  expect(result.map((e) => ("text" in e ? e.text : "boundary"))).toEqual(["fresh!", "other", "boundary", "new"]);
  expect(result[0]).toMatchObject({ id: "3", textMode: "snapshot", text: "fresh!" });
});

test("coalescing merges adjacent text-only deltas in delta mode while preserving tool events and identities", () => {
  const tool = { id: "t1", name: "bash", input: { command: "ls" } };
  const { textMode: _legacy, ...legacy } = message("9", "legacy");
  const result = coalesceEventMessages([
    { ...message("1", "Hel"), model: "claude-opus-4-6" },
    message("2", "lo "),
    { ...message("3", "world"), partial: false },
    { ...message("4", ""), tools: [tool] },
    message("5", "after "),
    message("6", "tool"),
    { ...message("7", "other-turn"), promptId: "p2" },
    { ...message("8", "other-conv"), conversationId: "c2" },
    legacy,
  ]);
  expect(result).toMatchObject([
    { id: "3", text: "Hello world", textMode: "delta", partial: false, model: "claude-opus-4-6", tools: [] },
    { id: "4", text: "", textMode: "delta", tools: [tool] },
    { id: "6", text: "after tool", textMode: "delta", tools: [] },
    { id: "7", text: "other-turn", promptId: "p2", textMode: "delta" },
    { id: "8", text: "other-conv", conversationId: "c2", textMode: "delta" },
    { id: "9", text: "legacy" },
  ]);
  const deltaWithToolThenSnapshot = coalesceEventMessages([
    { ...message("10", "pre"), tools: [tool] } as AgentEvent,
    message("11", "final", "snapshot"),
  ]);
  expect(deltaWithToolThenSnapshot).toMatchObject([
    { id: "10", text: "pre", textMode: "delta", tools: [tool] },
    { id: "11", text: "final", textMode: "snapshot", tools: [] },
  ]);
});

test("backward delta coalescing preserves raw cursors and cross-page text reconstruction", () => {
  const entries = [4, 3, 2, 1].map((n) => ({ cursor: `c${n}`, event: message(`e${n}`, String(n)) }));
  const tail = buildEventPage(entries.slice(0, 2), { limit: 2, coalesce: true, direction: "backward" }, true, "test");
  expect(tail).toMatchObject({
    cursor: "c4",
    olderCursor: "c3",
    hasMore: true,
    events: [{ id: "e4", text: "34", textMode: "delta" }],
  });
  const older = buildEventPage(
    entries.slice(2),
    { cursor: tail.olderCursor!, limit: 2, coalesce: true, direction: "backward" },
    false,
    "test",
  );
  expect(older).toMatchObject({
    cursor: "c2",
    olderCursor: "c1",
    hasMore: false,
    events: [{ id: "e2", text: "12", textMode: "delta" }],
  });
  const reconstructed = [...older.events, ...tail.events].reduce(
    (text, event) =>
      event.kind === "message" ? (event.textMode === "snapshot" ? event.text : text + event.text) : text,
    "",
  );
  expect(reconstructed).toBe("1234");
});

test("UTF-8 byte boundary retains raw continuation even after coalescing and returns an oversized single event alone", () => {
  const entries = [1, 2, 3].map((n) => ({ cursor: String(n), event: message(String(n), "é".repeat(35)) }));
  const first = buildEventPage(entries, { maxBytes: 300 }, false, "test");
  expect(first.events.map((e) => e.id)).toEqual(["1"]);
  expect(first.cursor).toBe("1");
  expect(first.hasMore).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(first.events)).length).toBeLessThanOrEqual(300);
  const coalesced = buildEventPage(entries, { maxBytes: 400, coalesce: true, direction: "backward" }, false, "test");
  expect(coalesced.cursor).toBe("1");
  expect(coalesced.olderCursor).toBe("3");
  expect(coalesced.events).toHaveLength(1);
  expect(coalesced.events[0]).toMatchObject({ id: "1", textMode: "delta", text: "é".repeat(105) });
  const oversized = buildEventPage(
    [{ cursor: "1", event: message("1", "x".repeat(2000)) }],
    { maxBytes: 300 },
    false,
    "test",
  );
  expect(oversized.events).toEqual([message("1", "x".repeat(2000))]);
  expect(oversized.cursor).toBe("1");
  const hard = buildEventPage(
    [{ cursor: "2", event: message("2", "x".repeat(1048576)) }, entries[0]!],
    { maxBytes: 300 },
    false,
    "test",
  );
  expect(hard.events).toMatchObject([
    { kind: "other", type: "event_truncated", data: { reason: "event_exceeds_hard_limit" } },
  ]);
  expect(hard.cursor).toBe("2");
  expect(hard.hasMore).toBe(true);
  const hugeContext = buildEventPage(
    [
      {
        cursor: "3",
        event: { ...message("3", ""), conversationId: "c".repeat(1048576), promptId: "p".repeat(1048576) },
      },
    ],
    {},
    false,
    "test",
  );
  expect(new TextEncoder().encode(JSON.stringify(hugeContext.events)).length).toBeLessThanOrEqual(1048576);
  expect(hugeContext.events).toMatchObject([{ data: { contextTruncated: true } }]);
  expect(hugeContext.events[0]).not.toHaveProperty("conversationId");
  expect(hugeContext.events[0]).not.toHaveProperty("promptId");
});
