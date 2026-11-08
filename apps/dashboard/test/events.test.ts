import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { describeEvent, isActiveStatus, mergeEvents, parseEventPage } from "../src/lib/events.ts";

const message = (id: string, text: string): AgentEvent => ({
  id,
  at: 1,
  kind: "message",
  text,
  partial: false,
  tools: [],
});

describe("events", () => {
  test("a page is appended once, in arrival order, whatever the poll returns twice", () => {
    const first = [message("a", "one"), message("b", "two")];
    const merged = mergeEvents(first, [message("b", "two"), message("c", "three")]);
    expect(merged.map((event) => event.id)).toEqual(["a", "b", "c"]);
    expect(mergeEvents(merged, [])).toEqual(merged);
  });

  test("only starting, ready, running and stopping sandboxes are polled", () => {
    expect((["starting", "ready", "running", "stopping"] as const).every(isActiveStatus)).toBe(true);
    expect((["stopped", "failed", "deleted"] as const).some(isActiveStatus)).toBe(false);
  });

  test("a failed prompt carries its reason to the line", () => {
    const line = describeEvent({
      id: "p",
      at: 5,
      kind: "prompt",
      text: "Do it",
      status: "failed",
      reason: "usage_limit",
    });
    expect(line).toMatchObject({ label: "Prompt failed", tone: "danger", failure: "usage_limit", text: "Do it" });
    expect(describeEvent(message("m", "hi"))).toMatchObject({ label: "Agent", tone: "neutral" });
  });

  test("a page from the server is read leniently and unreadable events are dropped", () => {
    const page = parseEventPage({
      events: [
        { id: "1", at: 10, kind: "message", text: "hello", tools: [{ id: "t", name: "Bash", input: {} }] },
        { id: "2", at: 11, kind: "prompt", text: "go", status: "bogus" },
        { id: "3", at: "late", kind: "message" },
        "junk",
        { id: "4", at: 12, kind: "other", type: "usage", data: { n: 1 } },
      ],
      cursor: "4",
      hasMore: true,
    });
    expect(page.events.map((event) => event.id)).toEqual(["1", "4"]);
    expect(page).toMatchObject({ cursor: "4", hasMore: true });
    expect(parseEventPage(null)).toEqual({ events: [], cursor: null, hasMore: false });
  });
});
