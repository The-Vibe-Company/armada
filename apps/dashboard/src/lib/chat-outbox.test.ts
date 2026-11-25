import { expect, test } from "bun:test";
import type { ChatItem } from "./chat";
import { type PendingMessage, unconfirmedMessages } from "./chat-outbox";

test("a server prompt replaces only its own optimistic bubble, even when messages have identical text", () => {
  const pending: PendingMessage[] = [
    { requestId: "first", promptId: "accepted-first", text: "Run the checks", at: 10 },
    { requestId: "second", promptId: "second", text: "Run the checks", at: 11 },
  ];
  const confirmed: ChatItem = {
    kind: "user",
    key: "prompt:accepted-first",
    promptId: "accepted-first",
    text: "Run the checks",
    status: "running",
    at: 12,
  };

  expect(unconfirmedMessages(pending, [confirmed])).toEqual([pending[1]]);
});
