import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginEventInputSchema, pluginEventSchema } from "@armada/plugin-api";
import {
  admitRequest,
  CHAT_LIVE_MINOR,
  clientMessageSchema,
  eventPayloadSchemas,
  eventSchema,
  PROTOCOL_VERSION,
  projectTablesSchema,
  serverMessageSchema,
} from "../dist/index.js";

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
  { type: "plugins.list", version, id: "plugins-a" },
  { type: "plugins.enable", version, id: "plugins-b", plugin: "lantern" },
  { type: "plugins.disable", version, id: "plugins-c", plugin: "lantern" },
  {
    type: "plugins.configure",
    version,
    id: "plugins-d",
    plugin: "lantern",
    seam: "tracker",
    kind: "lamps",
    config: { team: "EX", depth: 3 },
  },
  { type: "plugins.secret", version, id: "plugins-e", plugin: "lantern", name: "LAMP_TOKEN", value: "example-value" },
  { type: "daemon.restart", version, id: "restart-a" },
  { type: "chat.read", version, id: "chat-a", project: "project-a" },
  { type: "chat.send", version, id: "send-a", project: "project-a", requestId: "message-a", body: "Merge #12 first" },
  { type: "owner.answer", version, id: "answer-a", project: "project-a", item: "ask-a", choice: "Fix the wait" },
  { type: "owner.answer", version, id: "answer-b", project: "project-a", item: "ask-a", choice: "Wait", note: "Why?" },
  {
    type: "session.release",
    version,
    id: "release-a",
    project: "project-a",
    ticket: "EX-1",
    session: "session-a",
    generation: 2,
    reason: "Superseded by EX-2",
  },
  { type: "session.output", version, id: "output-a", project: "project-a", ticket: "EX-1", session: "session-a" },
  { type: "chat.stop", version, id: "stop-a", project: "project-a" },
];
const plugin = {
  id: "lantern",
  version: "1.0.0",
  description: "Reads the lamps",
  enabled: false,
  loaded: true,
  restartRequired: true,
  contributions: [
    {
      seam: "tracker",
      kind: "lamps",
      schema: { type: "object", properties: { team: { type: "string" } } },
      config: { team: "EX" },
      secrets: [{ name: "LAMP_TOKEN", set: false }],
    },
  ],
};
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
  { type: "chat.stopped", version, id: "stop-a", project: "project-a" },
  ...["idle", "thinking", "writing", "tool"].map((state) => ({
    type: "chat.turn",
    version,
    project: "project-a",
    state,
    since: "2026-01-01T00:00:00.000Z",
    queued: 2,
    ...(state === "tool" ? { tool: { id: "call-a", name: "fleet.status" } } : {}),
  })),
  ...["text", "reasoning"].map((kind) => ({
    type: "chat.delta",
    version,
    project: "project-a",
    id: "answer-a",
    kind,
    text: "The whole partial so far",
  })),
  ...[null, "All clear"].map((output) => ({
    type: "chat.tool",
    version,
    project: "project-a",
    id: "call-a",
    name: "fleet.status",
    input: {},
    output,
    failed: false,
    at: "2026-01-01T00:00:00.000Z",
  })),
  {
    type: "chat.result",
    version,
    id: "read-live",
    project: "project-a",
    seq: 10,
    coordinator: true,
    turn: {
      type: "chat.turn",
      version,
      project: "project-a",
      state: "writing",
      since: "2026-01-01T00:00:00.000Z",
      queued: 0,
    },
    items: [
      {
        kind: "coordinator",
        id: "answer-a",
        at: "2026-01-01T00:00:00.000Z",
        body: "Partial",
        reasoning: "Checking the fleet",
        aborted: true,
      },
    ],
  },
  { type: "owner.answered", version, id: "answer-a", project: "project-a", item: "ask-a" },
  {
    type: "session.release.result",
    version,
    id: "release-a",
    project: "project-a",
    ticket: "EX-1",
    session: "session-a",
    disposed: false,
  },
  {
    type: "session.output.result",
    version,
    id: "output-a",
    project: "project-a",
    ticket: "EX-1",
    session: "session-a",
    state: "running",
    activity: "working",
    lines: ["Reading the tide tables", "2 tests pass"],
  },
  { type: "error", version, id: "read-a", code: "not-found", message: "Session not found" },
  { type: "error", version, code: "invalid-message", message: "Invalid request" },
  { type: "plugins.result", version, id: "plugins-a", restartable: true, plugins: [plugin] },
  {
    type: "plugins.result",
    version,
    id: "plugins-b",
    restartable: false,
    plugins: [{ ...plugin, version: null, description: null, error: "pluginApi ^9 excludes 0.1.0", contributions: [] }],
  },
  { type: "daemon.restarting", version, id: "restart-a" },
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
    { ...requests[4], plugin: "" },
    { ...requests[6], config: { value: undefined } },
    { ...requests[7], value: "" },
    { ...requests[7], value: "two words" },
    { ...requests[10], body: " \n " },
    { ...requests[10], body: "x".repeat(16 * 1024 + 1) },
    { ...requests[10], requestId: "" },
    { ...requests[11], choice: "" },
    { ...requests[11], item: undefined },
    { ...requests[13], reason: " \n " },
    { ...requests[13], generation: 0 },
    { ...requests[13], session: undefined },
    { ...requests[14], ticket: "" },
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

test("known payload contracts validate checkpoint JSON and correlate session reporting phases", () => {
  const report = { ticket: "EX-1", session: "session-a", phase: "shipping", reason: "Review", stage: "review" };
  assert.deepEqual(eventPayloadSchemas["session.reported"].parse(report), report);
  for (const phase of ["released", "merged", "unknown"]) {
    assert.equal(eventPayloadSchemas["session.reported"].safeParse({ ...report, phase }).success, false);
  }
  const checkpoint = { checkpoint: { format: "example", writes: [null, true, 3, { body: "hello" }] } };
  assert.deepEqual(eventPayloadSchemas["coordinator.checkpoint"].parse(checkpoint), checkpoint);
  assert.equal(
    eventPayloadSchemas["coordinator.checkpoint"].safeParse({ checkpoint: { value: Infinity } }).success,
    false,
  );
});

test("folded tables validate known rows while preserving extension fields and serialized key order", () => {
  const claim = {
    handle: "local",
    runtime: "codex",
    owner: "Mira",
    generation: 1,
    session: "session-a",
    ticket: "EX-1",
    title: "Tend the orchard",
    phase: "shipping",
    state: "in-progress",
    reason: "Review",
    step: 3,
    flowStep: "review",
    at: "2030-01-01T10:00:00Z",
    heartbeat: null,
  };
  const tables = {
    tickets: [],
    pullRequests: [
      {
        head: "abc",
        number: 7,
        ticket: "EX-1",
        state: "open",
        ci: "pending",
        conflicting: false,
        review: "approved",
        checks: [],
      },
    ],
    sessions: [claim],
    sessionsByState: {
      blocked: [],
      "waiting-for-owner": [],
      "in-progress": [claim],
      "ready-to-merge": [],
      merged: [],
      released: [],
    },
    inbox: [],
    queue: [],
    holds: [],
    validations: [],
    extension: { value: true },
  };
  assert.equal(JSON.stringify(projectTablesSchema.parse(tables)), JSON.stringify(tables));
  for (const row of [
    { ...claim, phase: "unknown" },
    { ...claim, generation: -1 },
    { ...claim, heartbeat: 1 },
  ]) {
    assert.equal(projectTablesSchema.safeParse({ ...tables, sessions: [row] }).success, false);
  }
  assert.equal(projectTablesSchema.safeParse({ ...tables, sessionsByState: {} }).success, false);
  const rules = {
    revision: 1,
    value: {
      routing: [{ when: "Backend work", cli: "claude", model: "oak", instructions: "Check irrigation." }],
      placement: { workers: "vm", coordinator: "local" },
      policy: { maxWorkers: null },
    },
  };
  const configured = { ...tables, rules };
  assert.equal(JSON.stringify(projectTablesSchema.parse(configured)), JSON.stringify(configured));
  assert.equal(projectTablesSchema.safeParse({ ...tables, rules: { ...rules, revision: -1 } }).success, false);
  assert.equal(
    projectTablesSchema.safeParse({ ...tables, rules: { revision: 1, value: { policy: { silenceMinutes: 0 } } } })
      .success,
    false,
  );
  assert.equal(projectTablesSchema.safeParse({ ...tables, extension: { value: undefined } }).success, false);
});

test("plugin events admit the wire envelope, including offset dates and extension kinds", () => {
  const event = {
    seq: 1,
    project: "orchard",
    kind: "example.extension",
    at: "2030-01-01T10:00:00Z",
    actor: "example",
    payload: { future: [null, true, 3] },
  };
  const cases = [
    [event, true],
    [{ ...event, at: "2030-01-01T10:00:00.123+02:30" }, true],
    [{ ...event, at: "yesterday" }, false],
    [{ ...event, at: "2030-02-30T10:00:00Z" }, false],
    [{ ...event, at: "2030-01-01T10:00:00" }, false],
    [{ ...event, at: "" }, false],
    [{ ...event, seq: 0 }, false],
    [{ ...event, seq: Number.MAX_SAFE_INTEGER }, true],
    [{ ...event, seq: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ ...event, project: "" }, false],
    [{ ...event, kind: "" }, false],
    [{ ...event, actor: "" }, false],
    [{ ...event, payload: { invalid: undefined } }, false],
  ];
  for (const [input, valid] of cases) {
    assert.equal(eventSchema.safeParse(input).success, valid);
    assert.equal(pluginEventSchema.safeParse(input).success, valid);
    const { seq: _seq, ...append } = input;
    // Append omits only the cursor; a bad cursor does not affect append admission.
    assert.equal(
      pluginEventInputSchema.safeParse(append).success,
      "seq" in input && input.seq !== event.seq ? true : valid,
    );
  }
  assert.deepEqual(pluginEventSchema.parse(event), event);
});

test("live chat validates its bounded state and keeps older chat results readable", () => {
  assert.equal(CHAT_LIVE_MINOR, 7);
  assert.ok(PROTOCOL_VERSION.minor >= CHAT_LIVE_MINOR);
  const turn = frames.find((f) => f.type === "chat.turn");
  assert.ok(serverMessageSchema.safeParse(turn).success);
  for (const changes of [{ state: "busy" }, { queued: -1 }, { since: "yesterday" }, { tool: { name: "read" } }]) {
    assert.equal(serverMessageSchema.safeParse({ ...turn, ...changes }).success, false);
  }
  const delta = frames.find((f) => f.type === "chat.delta");
  assert.ok(serverMessageSchema.safeParse(delta).success);
  assert.equal(serverMessageSchema.safeParse({ ...delta, kind: "tokens" }).success, false);
  const old = frames.find((f) => f.type === "chat.result");
  assert.equal(serverMessageSchema.parse(old).turn, undefined);
});

test("runtime project management validates its distinct correlation/project ids and minor admission", () => {
  const v = { major: 1, minor: 12 };
  const add = {
    type: "projects.add",
    version: v,
    id: "request-add",
    projectId: "new-project",
    path: "/dev/new-project",
    name: "New project",
    repository: "example/project",
  };
  assert.equal(admitRequest(add).ok, true);
  assert.equal(
    admitRequest({ type: "projects.inspect", version: v, id: "inspect", path: "/dev/new-project" }).ok,
    true,
  );
  assert.equal(
    admitRequest({ type: "projects.remove", version: v, id: "request-remove", project: "new-project" }).ok,
    true,
  );
  for (const repository of ["malformed", "./project", "example/.."])
    assert.equal(admitRequest({ ...add, repository }).ok, false);
  assert.equal(admitRequest({ ...add, projectId: "" }).ok, false);
  assert.equal(admitRequest({ ...add, version: { major: 1, minor: 11 } }).ok, false);
  assert.equal(admitRequest(add, { major: 1, minor: 11 }).ok, false);
  const result = serverMessageSchema.parse({
    type: "projects.result",
    version: v,
    id: "request-add",
    projects: [{ id: "new-project", name: "New project", root: "/dev/new-project", repository: "example/project" }],
  });
  assert.equal(result.projects[0].root, "/dev/new-project");
});
