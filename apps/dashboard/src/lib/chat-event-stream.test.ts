import { afterEach, expect, setSystemTime, test } from "bun:test";
import { type ChatStreamFrame, chatEventStream } from "./chat-event-stream.ts";

const originalEventSource = globalThis.EventSource;
const connections: BrowserStream[] = [];

class BrowserStream {
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (message: { lastEventId: string; data: string }) => void;

  constructor(readonly url: string) {
    connections.push(this);
  }

  close() {
    this.closed = true;
  }
}

const sandboxId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  connections.length = 0;
});

test("connects at cursor=tail, parses inline runtime_event and transition frames, and resumes after newest id", () => {
  globalThis.EventSource = BrowserStream as unknown as typeof EventSource;
  setSystemTime(new Date(0));
  const frames: ChatStreamFrame[] = [];
  const opens: boolean[] = [];
  let disconnects = 0;
  const stream = chatEventStream(sandboxId, {
    onFrame: (frame) => frames.push(frame),
    onOpen: ({ fromTail }) => {
      opens.push(fromTail);
    },
    onDisconnect: () => {
      disconnects += 1;
    },
  });
  try {
    stream.connect();
    const [first] = connections;
    expect(first!.url).toBe(`/api/v1/events?sandbox=${sandboxId}&cursor=tail`);
    expect(stream.connected).toBe(false);

    first!.onopen!();
    expect(stream.connected).toBe(true);
    expect(opens).toEqual([true]);

    first!.onmessage!({
      lastEventId: "9007199254740993",
      data: JSON.stringify({
        id: "9007199254740993",
        sandboxId,
        sequence: "10",
        kind: "runtime_event",
        event: { id: "ev-10", at: 100, kind: "message", text: "Hello", partial: false, tools: [] },
      }),
    });
    first!.onmessage!({
      lastEventId: "9007199254740992",
      data: JSON.stringify({ id: "9007199254740992", sequence: "9", kind: "transition", status: "ready" }),
    });
    first!.onmessage!({
      lastEventId: "9007199254740993",
      data: JSON.stringify({ id: "9007199254740993", sequence: "10", kind: "transition", status: "ready" }),
    });
    first!.onmessage!({ lastEventId: "9007199254740994", data: "not-json" });

    expect(frames).toEqual([
      {
        id: "9007199254740993",
        sequence: "10",
        kind: "runtime_event",
        event: { id: "ev-10", at: 100, kind: "message", text: "Hello", partial: false, tools: [] },
      },
    ]);

    first!.onerror!();
    expect(first!.closed).toBe(true);
    expect(stream.connected).toBe(false);
    expect(disconnects).toBe(1);
    stream.connect();
    expect(connections).toHaveLength(1);

    setSystemTime(new Date(10_000));
    stream.connect();
    const second = connections[1]!;
    expect(second.url).toBe(`/api/v1/events?sandbox=${sandboxId}&cursor=9007199254740993`);
    second.onopen!();
    expect(opens).toEqual([true, false]);
    first!.onmessage!({
      lastEventId: "9007199254740994",
      data: JSON.stringify({ id: "9007199254740994", sequence: null, kind: "transition", status: "stopped" }),
    });
    second.onmessage!({
      lastEventId: "9007199254740994",
      data: JSON.stringify({
        id: "9007199254740994",
        sequence: null,
        kind: "transition",
        status: "stopped",
        statusReason: "idle_paused",
      }),
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      id: "9007199254740994",
      sequence: null,
      kind: "transition",
      status: "stopped",
      statusReason: "idle_paused",
    });

    stream.close();
    expect(stream.connected).toBe(false);
    second.onmessage!({
      lastEventId: "9007199254740995",
      data: JSON.stringify({ id: "9007199254740995", sequence: null, kind: "transition", status: "ready" }),
    });
    expect(frames).toHaveLength(2);
  } finally {
    stream.close();
    setSystemTime();
  }
});

test("allows JSON fallback when the browser lacks EventSource", () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  const stream = chatEventStream(sandboxId, {
    onFrame: () => {
      throw Error("No events should arrive without a stream");
    },
  });
  stream.connect();
  expect(stream.connected).toBe(false);
});
