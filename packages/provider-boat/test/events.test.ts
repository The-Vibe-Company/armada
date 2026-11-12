import { expect, test } from "bun:test";
import { fakeBoat } from "./support.ts";

const ID = "bx_23456789";

// The shapes boat documents for GET /events (docs.boat.dev, "List sandbox events").
const prompt = {
  id: "prompt_123",
  type: "prompt",
  timestamp: 1780347055370,
  taskId: "prompt_123",
  conversationId: "conv_1",
  data: { prompt: "Run tests and summarize failures.", status: "running", is_reverted: false },
};
const tools = {
  id: "response_123-tools",
  type: "response",
  timestamp: 1780347063427,
  taskId: "prompt_123",
  conversationId: "conv_1",
  data: {
    content: "",
    model: "gpt-5.4",
    tools: [
      {
        use: { id: "call_123", type: "tool_use", name: "Bash", input: { command: "npm test" } },
        result: { type: "tool_result", tool_use_id: "call_123", is_error: false, content: '{"exitCode":0}' },
      },
      { use: { id: "call_456", type: "tool_use", name: "Read", input: { path: "a.ts" } } },
    ],
  },
};
const partial = {
  id: "response_123",
  type: "response",
  timestamp: 1780347065650,
  taskId: "prompt_123",
  conversationId: "conv_1",
  data: { content: "Tests pa", model: "gpt-5.4", is_streaming: true },
};
const steered = {
  id: "steer_1",
  type: "steer",
  timestamp: 1780347066000,
  conversationId: "conv_1",
  data: { message: "Skip e2e", mode: "native" },
};
const future = { id: "x_1", type: "thinking", timestamp: 1780347067000, data: { depth: 2 } };
const failed = {
  id: "prompt_123-end",
  type: "prompt",
  timestamp: 1780347068000,
  taskId: "prompt_123",
  data: { status: "failed", error: "credit balance too low" },
};

test("events are normalized onto the common stream and never lose an unknown one", async () => {
  const boat = fakeBoat({
    body: {
      ok: true,
      type: "events.list",
      id: ID,
      events: [prompt, tools, partial, steered, future, failed],
      pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
    },
  });
  const page = await boat.provider.events({ sandboxId: ID });
  expect(page.events).toEqual([
    {
      kind: "prompt",
      id: "prompt_123",
      at: 1780347055370,
      conversationId: "conv_1",
      promptId: "prompt_123",
      text: "Run tests and summarize failures.",
      status: "running",
    },
    {
      kind: "message",
      id: "response_123-tools",
      at: 1780347063427,
      conversationId: "conv_1",
      promptId: "prompt_123",
      text: "",
      partial: false,
      model: "gpt-5.4",
      tools: [
        {
          id: "call_123",
          name: "Bash",
          input: { command: "npm test" },
          result: { output: '{"exitCode":0}', isError: false },
        },
        { id: "call_456", name: "Read", input: { path: "a.ts" } },
      ],
    },
    {
      kind: "message",
      id: "response_123",
      at: 1780347065650,
      conversationId: "conv_1",
      promptId: "prompt_123",
      text: "Tests pa",
      partial: true,
      model: "gpt-5.4",
      tools: [],
    },
    { kind: "steer", id: "steer_1", at: 1780347066000, conversationId: "conv_1", text: "Skip e2e", mode: "native" },
    { kind: "other", id: "x_1", at: 1780347067000, type: "thinking", data: { depth: 2 } },
    {
      kind: "prompt",
      id: "prompt_123-end",
      at: 1780347068000,
      promptId: "prompt_123",
      text: "",
      status: "failed",
      reason: "credit balance too low",
    },
  ]);
});

test("events are read oldest first, after the cursor, which anchors on the last event read", async () => {
  const boat = fakeBoat(
    {
      body: {
        ok: true,
        type: "events.list",
        id: ID,
        events: [prompt, tools],
        pageInfo: { nextCursor: "server-side", hasMore: true, limit: 2 },
      },
    },
    {
      body: {
        ok: true,
        type: "events.list",
        id: ID,
        events: [],
        pageInfo: { nextCursor: null, hasMore: false, limit: 2 },
      },
    },
  );
  const first = await boat.provider.events({ sandboxId: ID, conversationId: "conv_1", limit: 2 });
  expect(first.hasMore).toBe(true);
  // boat documents the cursor as base64url(`<timestamp>:<id>`) of the last event read.
  expect(first.cursor).toBe(Buffer.from("1780347063427:response_123-tools").toString("base64url"));

  const idle = await boat.provider.events({ sandboxId: ID, cursor: first.cursor as string });
  expect(idle.events).toEqual([]);
  expect(idle.cursor).toBe(first.cursor);
  expect(idle.hasMore).toBe(false);

  expect(boat.requests[0]).toMatchObject({ method: "GET", path: `/api/v1/sandboxes/${ID}/events` });
  expect(boat.requests[0]?.query.get("sort")).toBe("asc");
  expect(boat.requests[0]?.query.get("conversation")).toBe("conv_1");
  expect(boat.requests[0]?.query.get("limit")).toBe("2");
  expect(boat.requests[0]?.query.has("cursor")).toBe(false);
  expect(boat.requests[1]?.query.get("cursor")).toBe(first.cursor as string);
});

test("a sandbox never prompted has no events and no cursor", async () => {
  const boat = fakeBoat({ body: { ok: true, type: "events.list", id: ID, events: [] } });
  expect(await boat.provider.events({ sandboxId: ID })).toEqual({ events: [], hasMore: false });
});

// Provider normalization must not mistake a journal ID or streaming flag for message semantics.
test("Boat preserves supplied message semantics and leaves historical responses unidentified", async () => {
  const boat = fakeBoat({
    body: {
      ok: true,
      type: "events.list",
      id: ID,
      events: [
        { ...partial, data: { ...partial.data, message_id: "native-a", text_mode: "delta" } },
        { ...partial, id: "final", data: { content: "Tests pass", messageId: "native-a", textMode: "snapshot" } },
        partial,
      ],
      pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
    },
  });
  const page = await boat.provider.events({ sandboxId: ID });
  expect(page.events.map((e) => e.kind === "message" && [e.messageId, e.textMode])).toEqual([
    ["native-a", "delta"],
    ["native-a", "snapshot"],
    [undefined, undefined],
  ]);
});

test.each(["delta", "snapshot"] as const)(
  "backward %s-seeded pages anchor older history separately from forward follow",
  async (seed) => {
    const event = (n: number) => ({
      id: `e${n}`,
      timestamp: n,
      type: "response",
      conversationId: "c",
      taskId: "p",
      data: { content: String(n), message_id: "m", text_mode: n === 1 ? seed : "delta", is_streaming: true },
    });
    const response = (events: ReturnType<typeof event>[], hasMore = false) => ({
      body: {
        ok: true,
        type: "events.list",
        id: ID,
        events,
        pageInfo: { hasMore, limit: 2 },
      },
    });
    const boat = fakeBoat(
      response([event(4), event(3)], true),
      response([event(2), event(1)]),
      response([event(5)]),
      response([]),
    );
    const tail = await boat.provider.events({ sandboxId: ID, direction: "backward", limit: 2, coalesce: true });
    expect(tail.events).toMatchObject([
      { text: "3", textMode: "delta" },
      { text: "4", textMode: "delta" },
    ]);
    expect(tail.hasMore).toBe(true);
    const older = await boat.provider.events({
      sandboxId: ID,
      direction: "backward",
      cursor: tail.olderCursor!,
      limit: 2,
      coalesce: true,
    });
    const follow = await boat.provider.events({ sandboxId: ID, cursor: tail.cursor! });
    expect(older.events.map((e) => e.id)).toEqual(seed === "snapshot" ? ["e2"] : ["e1", "e2"]);
    if (seed === "snapshot") expect(older.events).toMatchObject([{ text: "12", textMode: "snapshot" }]);
    expect(
      [...older.events, ...tail.events].reduce(
        (text, event) =>
          event.kind === "message" ? (event.textMode === "snapshot" ? event.text : text + event.text) : text,
        "",
      ),
    ).toBe("1234");
    expect(follow.events.map((e) => e.id)).toEqual(["e5"]);
    expect(boat.requests.map((r) => r.query.get("sort"))).toEqual(["desc", "desc", "asc"]);
    expect(boat.requests[1]?.query.get("cursor")).toBe(Buffer.from("3:e3").toString("base64url"));
    expect(boat.requests[2]?.query.get("cursor")).toBe(Buffer.from("4:e4").toString("base64url"));
    expect(await boat.provider.events({ sandboxId: ID, direction: "backward" })).toEqual({
      events: [],
      hasMore: false,
    });
  },
);

test("history refuses missing raw anchors rather than skipping events at a byte boundary", async () => {
  const boat = fakeBoat({
    body: {
      ok: true,
      type: "events.list",
      id: ID,
      events: [{ type: "response", data: { content: "hello" } }],
      pageInfo: { nextCursor: "page-end", hasMore: false, limit: 100 },
    },
  });
  await expect(boat.provider.events({ sandboxId: ID, direction: "backward" })).rejects.toThrow(
    "stable pagination boundary",
  );
});

test("logs normalize recoverable Boat failures into closed interruption reasons", async () => {
  const boat = fakeBoat({
    body: {
      ok: true,
      type: "events.list",
      id: ID,
      events: [
        {
          ...failed,
          data: {
            status: "failed",
            error: "The box moved to a new machine while this prompt was running. Send it again.",
          },
        },
        {
          ...failed,
          id: "exit",
          data: {
            status: "failed",
            error: "Codex app-server exited with signal SIGTERM; the next prompt starts a fresh process",
          },
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
    },
  });
  const page = await boat.provider.events({ sandboxId: ID });
  expect(page.events).toMatchObject([
    { kind: "prompt", status: "interrupted", reason: "interrupted_by_provider_move" },
    { kind: "prompt", status: "interrupted", reason: "interrupted_by_harness_exit" },
  ]);
});

test("canonical plan diagnoses acquire metadata only on a failed prompt event", async () => {
  const statuses = ["queued", "running", "finished", "failed"];
  const reason = "Plan limit reached. Resets at 2026-11-10T00:00:00.000Z.";
  const boat = fakeBoat({
    body: {
      ok: true,
      type: "events.list",
      id: ID,
      events: statuses.map((status, i) => ({ ...prompt, id: String(i), data: { status, error: reason } })),
      pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
    },
  });
  const page = await boat.provider.events({ sandboxId: ID });
  expect(page.events.map((event) => (event.kind === "prompt" ? event.limit : undefined))).toEqual([
    undefined,
    undefined,
    undefined,
    { code: "usage_limit_exceeded", resetsAt: "2026-11-10T00:00:00.000Z" },
  ]);
});
