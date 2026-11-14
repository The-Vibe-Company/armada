import { expect, test } from "bun:test";
import { createBoatProvider } from "../src/provider.ts";
import { fakeBoat, KEY } from "./support.ts";

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
        events: [{ ...prompt, data: { ...prompt.data, status: "finished" } }, tools],
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

test.each((["delta", "snapshot"] as const).flatMap((seed) => [2, 500, 1000].map((limit) => ({ seed, limit }))))(
  "backward $seed-seeded pages preserve anchors with requested limit $limit",
  async ({ seed, limit }) => {
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
    const tail = await boat.provider.events({ sandboxId: ID, direction: "backward", limit, coalesce: true });
    expect(tail.events).toMatchObject([
      { text: "3", textMode: "delta" },
      { text: "4", textMode: "delta" },
    ]);
    expect(tail.hasMore).toBe(true);
    const older = await boat.provider.events({
      sandboxId: ID,
      direction: "backward",
      cursor: tail.olderCursor!,
      limit,
      coalesce: true,
    });
    const follow = await boat.provider.events({ sandboxId: ID, cursor: tail.cursor!, limit });
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
    // Boat's documented physical page maximum is 200, even though Armada's
    // logical history contract permits larger requested pages (the smoke uses 500).
    expect(boat.requests.map((r) => r.query.get("limit"))).toEqual(Array(3).fill(String(Math.min(limit, 200))));
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

test.each([
  [1, 262144],
  [100, 262144],
  [100, 256],
] as const)(
  "forward cursor observes an in-place terminal prompt and drains later answers (limit=%s, maxBytes=%s)",
  async (limit, maxBytes) => {
    const nativePrompt = { ...prompt, id: "prompt-event-row", data: { ...prompt.data, status: "running" } };
    const nativePartial = { ...partial, data: { ...partial.data } };
    // Force the active turn behind multiple physical pages, as on a reused sandbox.
    // Event row IDs deliberately differ from the prompt receipt's task ID.
    const history = [
      ...Array.from({ length: 201 }, (_, i) => ({
        ...prompt,
        id: `old-event-${i}`,
        timestamp: prompt.timestamp - 202 + i,
        taskId: `old-prompt-${i}`,
        data: { ...prompt.data, status: "finished" },
      })),
      nativePrompt,
      nativePartial,
    ] as (typeof prompt | typeof tools | typeof partial)[];
    const queries: URLSearchParams[] = [];
    const provider = createBoatProvider({
      apiKey: KEY,
      fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/commands"))
          return Response.json({
            ok: true,
            type: "command.finished",
            success: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
          });
        if (url.pathname.endsWith("/prompt"))
          return Response.json({
            ok: true,
            type: "prompt.queued",
            id: ID,
            promptId: prompt.taskId,
            conversationId: "conv_1",
            status: "queued",
          });
        if (!url.pathname.endsWith("/events")) throw Error("Unexpected native endpoint");
        queries.push(url.searchParams);
        const after = url.searchParams.get("cursor");
        const boundary = after ? Buffer.from(after, "base64url").toString("utf8") : undefined;
        const offset = boundary ? history.findIndex((e) => `${e.timestamp}:${e.id}` === boundary) + 1 : 0;
        const count = Number(url.searchParams.get("limit") ?? 100);
        const rows = history.slice(offset, offset + count);
        return Response.json({
          ok: true,
          type: "events.list",
          id: ID,
          events: rows,
          pageInfo: { hasMore: offset + rows.length < history.length, nextCursor: null, limit: count },
        });
      }) as typeof fetch,
    });
    const receipt = await provider.prompt({
      sandboxId: ID,
      harness: "claude",
      text: "follow-up",
      conversationId: "conv_1",
    });
    let running = await provider.events({ sandboxId: ID, limit, maxBytes });
    const initial = [...running.events];
    while (running.hasMore) {
      running = await provider.events({
        sandboxId: ID,
        ...(running.cursor ? { cursor: running.cursor } : {}),
        limit,
        maxBytes,
      });
      initial.push(...running.events);
    }
    expect(initial).toContainEqual(
      expect.objectContaining({
        id: nativePrompt.id,
        promptId: receipt.promptId,
        kind: "prompt",
        status: "running",
      }),
    );
    // The row's timestamp/id stay put. A native timestamp cursor cannot see this edit.
    nativePrompt.data.status = "finished";
    nativePartial.data.content = "SMOKE_OK";
    nativePartial.data.is_streaming = false;
    history.push({
      ...tools,
      id: "newest",
      timestamp: partial.timestamp + 1,
      data: { ...tools.data, content: "newest" },
    });
    let cursor = running.cursor;
    const observed = [];
    for (let page = 0; page < 3; page++) {
      const result = await provider.events({ sandboxId: ID, ...(cursor ? { cursor } : {}), limit, maxBytes });
      observed.push(...result.events);
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    expect(observed).toMatchObject([
      { id: nativePrompt.id, promptId: receipt.promptId, kind: "prompt", status: "finished", text: prompt.data.prompt },
      { id: partial.id, promptId: receipt.promptId, kind: "message", text: "SMOKE_OK", partial: false },
      { id: "newest", promptId: receipt.promptId, kind: "message", text: "newest" },
    ]);
    const idle = await provider.events({ sandboxId: ID, ...(cursor ? { cursor } : {}), limit, maxBytes });
    expect(idle.events).toEqual([]);
    expect(idle.cursor).toBe(cursor);
    // Native requests must never receive an Armada envelope.
    expect(queries.every((q) => !q.get("cursor")?.startsWith("armada-"))).toBe(true);
  },
);

test.each(["not-json", "null", '{"pending":[{"id":"x","before":5,"fingerprint":"bad"}]}'])(
  "malformed replay continuations fail before native I/O (%s)",
  async (value) => {
    const boat = fakeBoat();
    const cursor = "armada-boat-events-v1." + Buffer.from(value).toString("base64url");
    await expect(boat.provider.events({ sandboxId: ID, cursor })).rejects.toMatchObject({ code: "invalid_request" });
    expect(boat.requests).toHaveLength(0);
  },
);
