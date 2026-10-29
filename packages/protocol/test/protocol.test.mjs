import assert from "node:assert/strict";
import { test } from "node:test";
import { admitRequest, clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "../dist/index.js";

const version = { major: 1, minor: 0 };
const event = {
  seq: 7,
  project: "project-a",
  kind: "session.claimed",
  at: "2026-01-01T00:00:00.000Z",
  actor: "worker-a",
  payload: { session: "session-a", details: [null, true, 3, "text", { nested: [] }] },
};
const batch = {
  type: "events",
  version,
  subscriptionId: "subscription-a",
  project: "project-a",
  seq: 10,
  events: [event],
};
const session = {
  type: "session.result",
  version,
  id: "read-a",
  project: "project-a",
  sessionId: "session-a",
  seq: 10,
  events: [event],
};

// These fixtures are independent wire examples, including every message variant.
const requests = [
  { type: "projects.list", version, id: "list-a" },
  { type: "project.subscribe", version, id: "subscribe-a", project: "project-a", after: 6 },
  { type: "session.read", version, id: "read-a", project: "project-a", sessionId: "session-a" },
  { type: "chat.read", version, id: "chat-a", project: "project-a" },
  { type: "chat.send", version, id: "send-a", project: "project-a", requestId: "message-a", body: "Merge #12 first" },
  { type: "owner.answer", version, id: "answer-a", project: "project-a", item: "ask-a", choice: "Fix the wait" },
  { type: "owner.answer", version, id: "answer-b", project: "project-a", item: "ask-a", choice: "Wait", note: "Why?" },
];
const frames = [
  {
    type: "projects.result",
    version,
    id: "list-a",
    projects: [{ id: "project-a", name: "Example", repository: "example/repo" }],
  },
  {
    type: "project.subscribed",
    version,
    id: "subscribe-a",
    subscriptionId: "subscription-a",
    project: "project-a",
    after: 6,
  },
  session,
  batch,
  { ...batch, snapshot: { seq: 10, state: { sessions: [{ ticket: "EX-1", state: "blocked" }] } } },
  { ...batch, seq: 11, events: [] },
  {
    type: "chat.result",
    version,
    id: "chat-a",
    project: "project-a",
    seq: 10,
    coordinator: true,
    items: [
      { kind: "owner", id: "e2", at: "2026-01-01T00:00:00.000Z", body: "Merge #12 first" },
      { kind: "coordinator", id: "e3", at: "2026-01-01T00:00:01.000Z", body: "Merging #12 now" },
      { kind: "line", id: "m9", at: "2026-01-01T00:00:02.000Z", body: "#12 merged" },
      {
        kind: "tool",
        id: "call-a",
        at: "2026-01-01T00:00:01.000Z",
        name: "fleet.status",
        input: { ticket: "EX-1" },
        output: '{"ok":true}',
        failed: false,
      },
      {
        kind: "tool",
        id: "call-b",
        at: "2026-01-01T00:00:01.000Z",
        name: "hold.add",
        input: {},
        output: null,
        failed: false,
      },
    ],
  },
  { type: "chat.sent", version, id: "send-a", project: "project-a", requestId: "message-a" },
  { type: "owner.answered", version, id: "answer-a", project: "project-a", item: "ask-a" },
  { type: "error", version, id: "read-a", code: "not-found", message: "Session not found" },
  { type: "error", version, code: "invalid-message", message: "Invalid request" },
];

test("all client and server messages survive the JSON wire and runtime validation", () => {
  for (const [schema, examples] of [
    [clientMessageSchema, requests],
    [serverMessageSchema, frames],
  ]) {
    for (const example of examples) {
      assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(example))), example);
    }
  }
  for (const request of requests) {
    assert.deepEqual(admitRequest(request), { ok: true, request });
  }
});

test("an older app gets the exact upgrade line and a close instruction before body validation", () => {
  const result = admitRequest({ version: { major: 0, minor: 99 }, id: "old-a", type: "obsolete-request" });
  assert.deepEqual(result, {
    ok: false,
    close: true,
    error: {
      type: "error",
      version: PROTOCOL_VERSION,
      id: "old-a",
      code: "app-too-old",
      message: "Armada app is older than the daemon: update it",
    },
  });
  assert.deepEqual(serverMessageSchema.parse(result.error), result.error);
});

test("a newer app is refused, while same-major minor changes and additive fields are compatible", () => {
  const future = admitRequest({ ...requests[0], version: { major: 2, minor: 0 } });
  assert.equal(future.ok, false);
  assert.equal(future.close, true);
  assert.equal(future.error.code, "daemon-too-old");
  assert.deepEqual(serverMessageSchema.parse(future.error), future.error);
  for (const minor of [0, 100]) {
    const request = { ...requests[0], version: { major: 1, minor }, futureField: "ignored" };
    assert.deepEqual(admitRequest(request), { ok: true, request: { ...requests[0], version: request.version } });
  }
  const newerDaemon = { major: 2, minor: 4 };
  const refused = admitRequest(requests[0], newerDaemon);
  assert.equal(refused.close, true);
  assert.deepEqual(refused.error.version, newerDaemon);
});

test("invalid requests never become dispatchable and errors retain only a valid correlation id", () => {
  for (const request of [
    null,
    { ...requests[0], version: { major: -1, minor: 0 } },
    { ...requests[0], version: { major: 1.5, minor: 0 } },
    { ...requests[0], version: { major: 1, minor: "0" } },
    { ...requests[0], id: "" },
    { ...requests[0], type: "unknown" },
    { ...requests[1], after: -1 },
    { ...requests[1], after: Number.MAX_SAFE_INTEGER + 1 },
    { ...requests[1], project: "" },
    { ...requests[2], sessionId: null },
    { ...requests[4], body: " \n " },
    { ...requests[4], body: "x".repeat(16 * 1024 + 1) },
    { ...requests[4], requestId: "" },
    { ...requests[5], choice: "" },
    { ...requests[5], item: undefined },
  ]) {
    assert.equal(clientMessageSchema.safeParse(request).success, false);
    const result = admitRequest(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid-message");
    assert.deepEqual(serverMessageSchema.parse(result.error), result.error);
  }
  assert.equal(admitRequest({ ...requests[1], after: -1 }).error.id, "subscribe-a");
});

test("a frame's folded snapshot is at the frame's own cursor", () => {
  const snapshot = { seq: 10, state: { sessions: [] } };
  assert.equal(serverMessageSchema.safeParse({ ...batch, snapshot }).success, true);
  assert.equal(serverMessageSchema.safeParse({ ...batch, snapshot: { ...snapshot, seq: 9 } }).success, false);
});

test("replay frames preserve project isolation and strictly ordered safe sequence cursors", () => {
  // Global log gaps are valid: another project's events can occupy seq 8 and 9.
  assert.equal(serverMessageSchema.safeParse({ ...batch, events: [event, { ...event, seq: 10 }] }).success, true);
  for (const frame of [batch, session]) {
    for (const change of [
      { seq: 6 },
      { seq: -1 },
      { seq: 1.1 },
      { events: [{ ...event, project: "project-b" }] },
      { events: [{ ...event, seq: 0 }] },
      { events: [event, event] },
      { events: [{ ...event, seq: 8 }, event] },
      { events: [{ ...event, at: "yesterday" }] },
      { events: [{ ...event, payload: { value: undefined } }] },
      { events: [{ ...event, payload: { value: Infinity } }] },
    ]) {
      assert.equal(serverMessageSchema.safeParse({ ...frame, ...change }).success, false);
    }
  }
});
