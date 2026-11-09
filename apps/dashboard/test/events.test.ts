import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { isActiveStatus, mergeEvents, parseEventPage } from "../src/lib/events.ts";

const message = (id: string, text: string): AgentEvent => ({
  id,
  at: 1,
  kind: "message",
  text,
  partial: false,
  tools: [],
});

describe("events", () => {
  test("a page is appended once, in arrival order; an event read again keeps its place and takes the newer body", () => {
    const first = [message("a", "one"), message("b", "tw")];
    const merged = mergeEvents(first, [message("b", "two"), message("c", "three")]);
    expect(merged.map((event) => [event.id, event.kind === "message" && event.text])).toEqual([
      ["a", "one"],
      ["b", "two"],
      ["c", "three"],
    ]);
    expect(mergeEvents(merged, [])).toEqual(merged);
  });

  test("only starting, ready, running and stopping sandboxes are polled", () => {
    expect((["starting", "ready", "running", "stopping"] as const).every(isActiveStatus)).toBe(true);
    expect((["stopped", "failed", "deleted"] as const).some(isActiveStatus)).toBe(false);
  });

  test("a page from the server is read leniently and unreadable events are dropped", () => {
    const page = parseEventPage({
      events: [
        {
          id: "1",
          at: 10,
          kind: "message",
          text: "hello",
          model: "gpt-6.1-sol",
          messageId: "m1",
          textMode: "delta",
          tools: [{ id: "t", name: "Bash", input: { command: "ls" }, result: { output: "a", isError: true } }],
        },
        { id: "5", at: 13, kind: "message", text: "x", textMode: "chunk", messageId: 7, tools: [] },
        { id: "2", at: 11, kind: "prompt", text: "go", status: "bogus" },
        { id: "3", at: "late", kind: "message" },
        "junk",
        { id: "4", at: 12, kind: "other", type: "usage", data: { n: 1 } },
      ],
      cursor: "4",
      hasMore: true,
    });
    expect(page.events.map((event) => event.id)).toEqual(["1", "5", "4"]);
    expect(page.events[0]).toMatchObject({
      model: "gpt-6.1-sol",
      messageId: "m1",
      textMode: "delta",
      tools: [{ id: "t", name: "Bash", input: { command: "ls" }, result: { output: "a", isError: true } }],
    });
    expect(page.events[1]).not.toHaveProperty("textMode");
    expect(page.events[1]).not.toHaveProperty("messageId");
    expect(page).toMatchObject({ cursor: "4", hasMore: true });
    expect(parseEventPage(null)).toEqual({ events: [], cursor: null, hasMore: false });
  });
});
