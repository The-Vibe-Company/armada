import assert from "node:assert/strict";
import { once } from "node:events";
import { type TestContext, test } from "node:test";
import {
  CHAT_LIVE_MINOR,
  type ServerMessage,
  serverMessageSchema,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import type { ProjectCoordinator } from "../coordinator/index.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

const NOW = Date.parse("2030-01-01T10:00:00Z");
const projects = [{ id: "orchard", name: "Orchard", repository: "example/orchard" }];
const assistant = (content: unknown[], stopReason = "stop") => ({
  role: "assistant",
  content,
  timestamp: NOW,
  stopReason,
});
const entry = (id: number, kind: string, model: unknown, task = 7) =>
  ({ id, conversationId: 1, byTaskId: task, kind, model: [model] }) as unknown as EntryRecord;
const initial = [entry(1, "pi.user", { role: "user", content: "Check the orchard", timestamp: NOW })];

function clock() {
  let time = NOW;
  const timers = new Map<() => void, number>();
  return {
    now: () => time,
    setTimer(callback: () => void, delay: number) {
      timers.set(callback, time + delay);
      return () => {
        timers.delete(callback);
      };
    },
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0];
        if (!next || next[1] > target) break;
        time = next[1];
        timers.delete(next[0]);
        next[0]();
      }
      time = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

function conversation() {
  let value: ConversationView;
  const listeners = new Set<(value: ConversationView) => void>();
  let opened = 0;
  let disposed = 0;
  let aborted = 0;
  let onAbort = () => {};
  const view = {
    get value() {
      return value;
    },
    subscribe(listener: (value: ConversationView) => void) {
      listeners.add(listener);
      listener(value);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed++;
      listeners.clear();
    },
  };
  const fake = {
    viewState: async () => {
      opened++;
      return view;
    },
    abort: async () => {
      aborted++;
      onAbort();
    },
  };
  const set = (live: LiveState, entries = initial, queued: unknown[] = []) => {
    value = {
      conversation: { id: 1 },
      entries,
      docs: { "pi.live": live, "pi.inbox": { items: queued } },
    } as unknown as ConversationView;
    for (const listener of listeners) listener(value);
  };
  set({ run: { taskId: 7, inputs: [] } } as unknown as LiveState);
  return {
    fake,
    view,
    set,
    onAbort(fn: () => void) {
      onAbort = fn;
    },
    get opened() {
      return opened;
    },
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
    },
  };
}

async function client(url: string, minor = CHAT_LIVE_MINOR) {
  const ws = new WebSocket(url);
  const frames: ServerMessage[] = [];
  let wake = () => {};
  ws.on("message", (data) => {
    frames.push(serverMessageSchema.parse(JSON.parse(String(data))));
    wake();
  });
  await once(ws, "open");
  async function until(predicate: (frame: ServerMessage) => boolean) {
    for (;;) {
      const found = frames.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  let n = 0;
  async function ask(body: Record<string, unknown>) {
    const id = `request-${++n}`;
    ws.send(JSON.stringify({ version: { ...version, minor }, id, ...body }));
    return until((f) => "id" in f && f.id === id);
  }
  return {
    ws,
    frames,
    until,
    ask,
    subscribe: () => ask({ type: "project.subscribe", project: "orchard", after: 0 }),
    read: () => ask({ type: "chat.read", project: "orchard" }),
  };
}

async function setup(t: TestContext, fake = conversation()) {
  const store = new EventStore(":memory:");
  const time = clock();
  const server = await startServer({ store, projects, chatClock: time });
  // The server exposes its coordinator registry; supply a fake of the public conversation API, not pi storage.
  (server.coordinators as Map<string, ProjectCoordinator>).set("orchard", {
    conversation: fake.fake,
  } as unknown as ProjectCoordinator);
  const clients: Awaited<ReturnType<typeof client>>[] = [];
  t.after(async () => {
    for (const c of clients) c.ws.terminate();
    await server.close();
    store.close();
  });
  const connect = async (minor = CHAT_LIVE_MINOR) => {
    const c = await client(server.wsUrl, minor);
    clients.push(c);
    return c;
  };
  return { fake, time, server, connect };
}

test("a room streams committed turns, coalesced whole partials and tool results, and Stop aborts once", {
  timeout: 5000,
}, async (t) => {
  const { fake, time, connect } = await setup(t);
  const c = await connect();
  await c.subscribe();
  await c.until((f) => f.type === "chat.turn");
  const run = { taskId: 7, inputs: [] } as unknown as NonNullable<LiveState["run"]>;
  const partial = (text: string) =>
    ({
      run,
      generation: {
        attempt: 1,
        message: assistant([
          { type: "text", text },
          { type: "thinking", thinking: "Checking the trees" },
        ]),
      },
    }) as unknown as LiveState;
  fake.set(partial("One"));
  time.advance(10);
  fake.set(partial("One complete reading"));
  const mid = await c.read();
  assert.ok(mid.type === "chat.result" && mid.turn?.state === "writing");
  assert.equal(c.frames.filter((f) => f.type === "chat.delta").length, 0);
  time.advance(70);
  await c.read(); // An ordered socket barrier, not a wall-clock wait.
  assert.equal(c.frames.filter((f) => f.type === "chat.delta").length, 1, "one aggregate frame per 80ms tick");
  time.advance(79);
  await c.read();
  assert.equal(c.frames.filter((f) => f.type === "chat.delta").length, 1);
  time.advance(1);
  await c.read();
  const deltas = c.frames.filter((f) => f.type === "chat.delta");
  assert.deepEqual(
    deltas.map((f) => [f.kind, f.text]),
    [
      ["text", "One complete reading"],
      ["reasoning", "Checking the trees"],
    ],
  );
  const call = { type: "toolCall", id: "status-1", name: "fleet.status", arguments: { scope: "all" } };
  const answer = entry(
    2,
    "pi.assistant",
    assistant(
      [{ type: "text", text: "One complete reading" }, { type: "thinking", thinking: "Checking the trees" }, call],
      "toolUse",
    ),
  );
  fake.set({ run, tools: [{ callId: "status-1", name: "fleet.status", status: "running" }] }, [...initial, answer]);
  await c.until((f) => f.type === "chat.tool");
  const output = JSON.stringify({ ok: false, message: "x".repeat(9000) });
  const result = entry(3, "pi.tool-result", {
    role: "toolResult",
    toolCallId: "status-1",
    content: [{ type: "text", text: output }],
    timestamp: NOW,
  });
  fake.set({ run, tools: [{ callId: "status-1", name: "fleet.status", status: "done", entry: result.id }] }, [
    ...initial,
    answer,
    result,
  ]);
  fake.set({}, [...initial, answer, result]);
  const done = await c.read();
  assert.ok(done.type === "chat.result");
  const tools = c.frames.filter((f) => f.type === "chat.tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.output, null);
  assert.equal(tools[1]?.output, `${output.slice(0, 8192)}…`);
  assert.equal(tools[1]?.failed, true);
  const ended = tools[1];
  assert.ok(ended);
  const { type: _type, version: _version, project: _project, ...toolItem } = ended;
  assert.deepEqual(
    done.items.find((i) => i.kind === "tool"),
    { ...toolItem, kind: "tool" },
  );
  assert.equal(done.items.find((i) => i.kind === "coordinator")?.id, deltas[0]?.id);
  assert.deepEqual(
    c.frames.filter((f) => f.type === "chat.turn").map((f) => f.state),
    ["thinking", "writing", "tool", "idle"],
  );

  fake.set(partial("Stopped halfway"), [...initial]);
  time.advance(80);
  await c.read();
  fake.onAbort(() =>
    fake.set({}, [
      ...initial,
      entry(
        4,
        "pi.assistant",
        assistant(
          [
            { type: "text", text: "Stopped halfway" },
            { type: "thinking", thinking: "Checking the trees" },
          ],
          "aborted",
        ),
      ),
    ]),
  );
  const stopped = await c.ask({ type: "chat.stop", project: "orchard" });
  assert.equal(stopped.type, "chat.stopped");
  assert.equal(fake.aborted, 1);
  const after = await c.read();
  assert.ok(after.type === "chat.result");
  const item = after.items.find((i) => i.kind === "coordinator");
  assert.ok(item?.kind === "coordinator" && item.aborted && item.reasoning === "Checking the trees");
  const last = c.frames.findLast((f) => f.type === "chat.delta" && f.kind === "text");
  assert.equal(item.id, last?.type === "chat.delta" ? last.id : undefined);
});

test("subscribers share a project view, late rooms read current state, and legacy clients receive only events", {
  timeout: 5000,
}, async (t) => {
  const { fake, time, connect } = await setup(t);
  const legacy = await connect(CHAT_LIVE_MINOR - 1);
  await legacy.subscribe();
  assert.equal(fake.opened, 0);
  const a = await connect();
  await a.subscribe();
  await a.until((f) => f.type === "chat.turn");
  const b = await connect();
  await b.subscribe();
  await b.until((f) => f.type === "chat.turn");
  assert.equal(fake.opened, 1);
  fake.set(
    {
      run: { taskId: 7, inputs: [] },
      generation: { attempt: 2, retry: { at: NOW + 1000, error: "private-provider-error" } },
    } as unknown as LiveState,
    initial,
    [{ mode: "followUp" }, { mode: "write" }],
  );
  const mid = await b.read();
  assert.ok(mid.type === "chat.result" && mid.turn?.state === "thinking" && mid.turn.queued === 1);
  fake.set({
    run: { taskId: 7, inputs: [] },
    generation: { attempt: 2, deferred: { pollAt: NOW + 2000 } },
  } as unknown as LiveState);
  await a.read();
  assert.equal(JSON.stringify(a.frames).includes("private-provider-error"), false);
  await legacy.read();
  assert.equal(
    legacy.frames.some((f) => ["chat.turn", "chat.delta", "chat.tool"].includes(f.type)),
    false,
  );
  assert.ok(legacy.frames.some((f) => f.type === "events"));
  const oldRead = legacy.frames.find((f) => f.type === "chat.result");
  assert.ok(oldRead?.type === "chat.result" && !oldRead.turn);
  a.ws.close();
  await once(a.ws, "close");
  await b.subscribe();
  await b.read();
  assert.equal(fake.disposed, 0);
  b.ws.close();
  await once(b.ws, "close");
  await legacy.ask({ type: "projects.list" });
  assert.equal(fake.disposed, 1);
  assert.equal(time.pending, 0);
});

test("a view that attaches after the last subscriber disconnects is disposed", { timeout: 5000 }, async (t) => {
  const fake = conversation();
  let resolve!: (value: typeof fake.view) => void;
  let started!: () => void;
  const attaching = new Promise<void>((r) => {
    started = r;
  });
  fake.fake.viewState = () => {
    started();
    return new Promise((r) => {
      resolve = r;
    });
  };
  const { server, connect } = await setup(t, fake);
  const c = await connect();
  await c.subscribe();
  await attaching;
  c.ws.close();
  await once(c.ws, "close");
  const closing = server.close();
  const beforeAttachment = await Promise.race([
    closing.then(() => "closed"),
    new Promise<string>((r) => setImmediate(() => r("pending"))),
  ]);
  resolve(fake.view);
  await closing;
  assert.equal(beforeAttachment, "pending", "shutdown waits for detached pending views");
  assert.equal(fake.disposed, 1);
});

test("an immediate reconnect reuses a pending project attachment", { timeout: 5000 }, async (t) => {
  const fake = conversation();
  let resolve!: (view: typeof fake.view) => void;
  const pending = new Promise<typeof fake.view>((r) => {
    resolve = r;
  });
  let opened = 0;
  fake.fake.viewState = () => {
    opened++;
    return pending;
  };
  const { connect } = await setup(t, fake);
  const a = await connect();
  await a.subscribe();
  a.ws.close();
  await once(a.ws, "close");
  const b = await connect();
  await b.subscribe();
  resolve(fake.view);
  await b.until((f) => f.type === "chat.turn");
  assert.equal(opened, 1);
  assert.equal(fake.disposed, 0);
});

test("reasoning-only model errors retain the safe failure indication", { timeout: 5000 }, async (t) => {
  const { fake, connect } = await setup(t);
  fake.set({}, [
    ...initial,
    entry(2, "pi.assistant", {
      ...assistant([{ type: "thinking", thinking: "Checking the rows" }], "error"),
      errorMessage: "private-provider-error",
    }),
  ]);
  const c = await connect();
  const read = await c.read();
  assert.ok(read.type === "chat.result");
  const failure = read.items.at(-1);
  assert.ok(failure?.kind === "line");
  assert.equal(failure.body, "The coordinator's model failed on this turn.");
  assert.equal(failure.reasoning, "Checking the rows");
  assert.equal(JSON.stringify(read).includes("private-provider-error"), false);
});

test("a faulted tool remains failed when pi clears the round, including a fresh attachment", {
  timeout: 5000,
}, async (t) => {
  const { fake, connect } = await setup(t);
  const run = { taskId: 7, inputs: [] } as unknown as NonNullable<LiveState["run"]>;
  const call = { type: "toolCall", id: "status-1", name: "fleet.status", arguments: {} };
  const entries = [...initial, entry(2, "pi.assistant", assistant([call], "toolUse"))];
  fake.set({ run, tools: [{ callId: "status-1", name: "fleet.status", status: "running" }] }, entries);
  const c = await connect();
  await c.subscribe();
  await c.until((f) => f.type === "chat.tool");
  fake.set({ run, tools: [{ callId: "status-1", name: "fleet.status", status: "done" }] }, entries);
  await c.read();
  fake.set({}, entries);
  const after = await c.read();
  assert.ok(after.type === "chat.result");
  const tool = after.items.find((i) => i.kind === "tool");
  assert.ok(tool?.kind === "tool" && tool.failed);
  assert.equal(tool.output, "The tool did not complete.");
  assert.deepEqual(
    c.frames.filter((f) => f.type === "chat.tool").map((f) => f.failed),
    [false, true],
  );
  c.ws.close();
  await once(c.ws, "close");
  const restored = await (await connect()).read();
  assert.deepEqual(restored.type === "chat.result" && restored.items, after.items);
});
