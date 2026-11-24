import { afterEach, expect, setSystemTime, test } from "bun:test";
import { chatEventStream } from "./chat-event-stream.ts";

const originalEventSource = globalThis.EventSource;
const connections: BrowserStream[] = [];

class BrowserStream {
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (message: { lastEventId: string }) => void;

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

test("resumes after the newest event and ignores duplicate and stale notifications", () => {
  globalThis.EventSource = BrowserStream as unknown as typeof EventSource;
  setSystemTime(new Date(0));
  let updates = 0;
  const stream = chatEventStream(sandboxId, () => updates++);
  try {
    stream.connect();
    const [first] = connections;
    expect(first!.url).toBe(`/api/v1/events?sandbox=${sandboxId}&cursor=0`);
    first!.onopen!();
    first!.onmessage!({ lastEventId: "9007199254740993" });
    first!.onmessage!({ lastEventId: "9007199254740992" });
    first!.onmessage!({ lastEventId: "9007199254740993" });
    expect(updates).toBe(2);

    first!.onerror!();
    expect(first!.closed).toBe(true);
    expect(stream.waitingForEvents).toBe(false);
    expect(updates).toBe(3);
    stream.connect();
    expect(connections).toHaveLength(1);

    setSystemTime(new Date(10_000));
    stream.connect();
    const second = connections[1]!;
    expect(second.url).toBe(`/api/v1/events?sandbox=${sandboxId}&cursor=9007199254740993`);
    second.onopen!();
    first!.onmessage!({ lastEventId: "9007199254740994" });
    second.onmessage!({ lastEventId: "9007199254740994" });
    expect(updates).toBe(5);

    stream.close();
    second.onmessage!({ lastEventId: "9007199254740995" });
    expect(second.closed).toBe(true);
    expect(updates).toBe(5);
  } finally {
    stream.close();
    setSystemTime();
  }
});

test("allows JSON fallback when the browser lacks EventSource", () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  const stream = chatEventStream(sandboxId, () => {
    throw Error("No events should arrive without a stream");
  });
  stream.connect();
  expect(stream.waitingForEvents).toBe(false);
});
