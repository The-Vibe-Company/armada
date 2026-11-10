import { expect, test } from "bun:test";
import { type AgentEvent, buildEventPage, coalesceEventMessages } from "../src/index.ts";

const message = (id: string, text: string, mode: "delta" | "snapshot" = "delta"): AgentEvent => ({
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
});

test("UTF-8 byte boundary retains raw continuation even after coalescing and rejects an oversized single event", () => {
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
  expect(() =>
    buildEventPage([{ cursor: "1", event: message("1", "x".repeat(2000)) }], { maxBytes: 300 }, false, "test"),
  ).toThrow("exceeds maxBytes");
});
