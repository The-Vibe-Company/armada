import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { applyChatPage, applyInlineEvent, initialChatHistory, isActiveStatus, parseEventPage } from "./events.ts";

const message = (id: string, text: string) =>
  ({
    id,
    at: 1,
    kind: "message",
    text,
    partial: false,
    tools: [],
  }) satisfies AgentEvent;

describe("events", () => {
  test("replaying conversation events updates their bodies without appending duplicates", () => {
    const first = applyChatPage(
      initialChatHistory,
      { events: [message("a", "one"), message("b", "tw")], cursor: "2", hasMore: false },
      "forward",
    )!;
    const replay = applyChatPage(
      first,
      { events: [message("b", "two"), message("c", "three")], cursor: "3", hasMore: false },
      "forward",
    )!;
    expect(replay.events.map((event) => [event.id, event.kind === "message" && event.text])).toEqual([
      ["a", "one"],
      ["b", "two"],
      ["c", "three"],
    ]);
  });

  test("a rejected continuation leaves the last applied cursor available for the next read", () => {
    const first = applyChatPage(
      initialChatHistory,
      { events: [message("a", "one")], cursor: "1", hasMore: true },
      "forward",
    )!;
    expect(
      applyChatPage(first, { events: [message("b", "truncated")], cursor: "1", hasMore: true }, "forward"),
    ).toBeNull();
    expect(first).toMatchObject({ cursor: "1", events: [message("a", "one")] });
    const resumed = applyChatPage(first, { events: [message("b", "two")], cursor: "2", hasMore: false }, "forward");
    expect(resumed).toMatchObject({ cursor: "2", events: [message("a", "one"), message("b", "two")] });
  });

  test("loading older history keeps the forward resume position and the live version of an overlapping event", () => {
    const latest = applyChatPage(
      initialChatHistory,
      { events: [message("b", "live")], cursor: "2", olderCursor: "before-b", hasMore: true },
      "latest",
    )!;
    const older = applyChatPage(
      latest,
      { events: [message("a", "first"), message("b", "old")], cursor: "1", hasMore: false },
      "older",
    );
    expect(older).toMatchObject({
      cursor: "2",
      olderCursor: null,
      events: [message("a", "first"), message("b", "live")],
    });
  });

  test("only starting, ready, running and stopping sandboxes are active", () => {
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
      olderCursor: "1",
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
    expect(page).toMatchObject({ cursor: "4", olderCursor: "1", hasMore: true });
    expect(parseEventPage(null)).toEqual({ events: [], cursor: null, hasMore: false });
  });

  test("applyInlineEvent skips sequences already covered by runtime history and advances cursor on newer frames", () => {
    const sandboxId = "11111111-1111-4111-8111-111111111111";
    const base = applyChatPage(
      initialChatHistory,
      { events: [message("m-2", "coalesced")], cursor: `ar1_${sandboxId}_2`, hasMore: false },
      "latest",
    )!;
    expect(applyInlineEvent(base, sandboxId, message("m-1", "stale"), "1")).toBe(base);
    expect(applyInlineEvent(base, sandboxId, message("m-2", "dup"), "2")).toBe(base);

    const next = applyInlineEvent(base, sandboxId, message("m-3", "live"), "3");
    expect(next.cursor).toBe(`ar1_${sandboxId}_3`);
    expect(next.events.map((event) => event.id)).toEqual(["m-2", "m-3"]);

    const gapped = applyInlineEvent(next, sandboxId, message("m-5", "after-gap"), "5");
    expect(gapped.cursor).toBe(`ar1_${sandboxId}_3`);
    expect(gapped.events.map((event) => event.id)).toEqual(["m-2", "m-3", "m-5"]);

    const olderPage = applyChatPage(
      next,
      { events: [message("m-2", "coalesced")], cursor: `ar1_${sandboxId}_2`, hasMore: false },
      "forward",
    )!;
    expect(olderPage.cursor).toBe(`ar1_${sandboxId}_3`);

    const legacy = applyChatPage(
      initialChatHistory,
      { events: [message("a", "one")], cursor: "opaque-1", hasMore: false },
      "forward",
    )!;
    const merged = applyInlineEvent(legacy, sandboxId, message("a", "updated"), null);
    expect(merged.cursor).toBe("opaque-1");
    expect(merged.events).toEqual([message("a", "updated")]);
  });
});
