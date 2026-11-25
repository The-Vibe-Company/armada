import { expect, test } from "bun:test";
import type { ChatItem } from "./chat";
import { failPendingMessage, hasActivePendingMessages, type PendingMessage, unconfirmedMessages } from "./chat-outbox";

test("a server prompt replaces only its own optimistic bubble, even when messages have identical text", () => {
  const pending: [PendingMessage, PendingMessage] = [
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

test("a queued retry is confirmed by its public request ID even when its receipt uses the runtime ID", () => {
  const pending = { requestId: "request", promptId: "runtime", text: "Continue", at: 0 };
  const confirmed: ChatItem = {
    kind: "user",
    key: "prompt:request",
    promptId: "request",
    text: "Continue",
    status: "running",
    at: 1,
  };
  expect(unconfirmedMessages([pending], [confirmed])).toEqual([]);
});

test("pre-dispatch failure settles the queued bubble by its public request ID", () => {
  const pending = { requestId: "request", promptId: "runtime", text: "Continue", at: 0 };
  expect(failPendingMessage([pending], "request", "Sandbox stopped")).toEqual([
    { ...pending, failure: "Sandbox stopped" },
  ]);
});

test("optimistic steer bubbles confirm by arrival count and active outbox flips working immediately", () => {
  const steerA: PendingMessage = {
    requestId: "s1",
    promptId: "s1",
    text: "Focus on tests",
    at: 10,
    kind: "steer",
    confirmedBefore: 0,
  };
  const steerB: PendingMessage = {
    requestId: "s2",
    promptId: "s2",
    text: "Focus on tests",
    at: 11,
    kind: "steer",
    confirmedBefore: 1,
  };
  expect(hasActivePendingMessages([steerA])).toBe(true);
  expect(hasActivePendingMessages([{ ...steerA, failure: "Refused" }])).toBe(false);
  expect(unconfirmedMessages([steerA, steerB], [])).toEqual([steerA, steerB]);
  const oneConfirmed: ChatItem = { kind: "steer", key: "event:1", at: 12, text: "Focus on tests" };
  expect(unconfirmedMessages([steerA, steerB], [oneConfirmed])).toEqual([steerB]);
  const twoConfirmed: ChatItem = { kind: "steer", key: "event:2", at: 13, text: "Focus on tests" };
  expect(unconfirmedMessages([steerA, steerB], [oneConfirmed, twoConfirmed])).toEqual([]);
});
