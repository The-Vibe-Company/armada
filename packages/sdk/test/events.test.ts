import { expect, jest, test } from "bun:test";
import { Armada, reduceSandboxEvent } from "../src/index.ts";

const sandbox = "f6bc7a23-f891-4cd6-a034-acee682a9781";
const encoder = new TextEncoder();
const headers = { "content-type": "text/event-stream" };

function frame(id: string, kind = "runtime_event", extra: Record<string, unknown> = {}) {
  const event = {
    id,
    kind,
    sandboxId: sandbox,
    sequence: kind === "transition" ? null : "5",
    ref: "5",
    createdAt: "2026-11-20T12:00:00.000Z",
    ...extra,
  };
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

test("streams split frames, reconnects after the last complete event and ignores replayed IDs", async () => {
  const cursor = "9007199254740992";
  const first = "9007199254740993";
  const second = "9007199254740994";
  const requests: { query: string; lastId: string | null }[] = [];
  const client = new Armada({
    token: "placeholder",
    fetch: async (url, init) => {
      const request = new Request(String(url), init);
      expect(request.headers.get("authorization")).toBe("Bearer placeholder");
      expect(request.headers.get("accept")).toBe("text/event-stream");
      expect(new URL(request.url).pathname).toBe("/api/v1/events");
      requests.push({ query: new URL(request.url).search, lastId: request.headers.get("last-event-id") });
      if (requests.length === 1) {
        const complete = frame(first);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`: heartbeat\n\n${complete.slice(0, 28)}`));
            controller.enqueue(encoder.encode(complete.slice(28) + frame(second).slice(0, -1)));
            controller.close();
          },
        });
        return new Response(body, { headers });
      }
      return new Response(frame(first) + frame(second, "transition"), { headers });
    },
  });

  const stream = client.events.stream({ sandbox, cursor });
  const initial = (await stream.next()).value!;
  const next = (await stream.next()).value!;
  await stream.return();
  expect([initial.id, next.id]).toEqual([first, second]);
  expect(requests).toEqual([
    { query: `?sandbox=${sandbox}&cursor=${cursor}`, lastId: null },
    { query: `?sandbox=${sandbox}`, lastId: first },
  ]);
  const state = reduceSandboxEvent(reduceSandboxEvent(undefined, initial), next);
  expect(state).toMatchObject({ cursor: second, runtimeEvent: initial, transition: next });
  expect(reduceSandboxEvent(state, initial)).toBe(state);
});

test("cursor=tail reconnects at tail until the first event and preserves inline event and transition status", async () => {
  jest.useFakeTimers();
  const timer = observeRetryTimer();
  const requests: { query: string; lastId: string | null }[] = [];
  const inline = { id: "m1", at: 1, kind: "message", text: "hello", partial: false, tools: [] };
  const client = new Armada({
    token: "placeholder",
    fetch: async (url, init) => {
      const request = new Request(String(url), init);
      requests.push({ query: new URL(request.url).search, lastId: request.headers.get("last-event-id") });
      if (requests.length === 1) return new Response(null, { status: 503, headers: { "retry-after": "1" } });
      if (requests.length === 2) return new Response(frame("10", "runtime_event", { event: inline }), { headers });
      return new Response(frame("11", "transition", { status: "stopped", statusReason: "idle_paused" }), { headers });
    },
  });
  const stream = client.events.stream({ sandbox, cursor: "tail" });
  try {
    const firstPending = stream.next();
    await timer.scheduled();
    jest.advanceTimersByTime(1000);
    const first = (await firstPending).value!;
    const second = (await stream.next()).value!;
    expect(first).toMatchObject({ id: "10", kind: "runtime_event", event: inline });
    expect(second).toMatchObject({ id: "11", kind: "transition", status: "stopped", statusReason: "idle_paused" });
    expect(requests).toEqual([
      { query: `?sandbox=${sandbox}&cursor=tail`, lastId: null },
      { query: `?sandbox=${sandbox}&cursor=tail`, lastId: null },
      { query: `?sandbox=${sandbox}`, lastId: "10" },
    ]);
  } finally {
    await stream.return();
    timer.restore();
    jest.useRealTimers();
  }
});

test("aborting a pending read cancels the reader and ends the iterator", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const client = new Armada({
    token: "placeholder",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame("1")));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers },
      ),
  });
  const stream = client.events.stream({ sandbox }, { signal: abort.signal });
  expect((await stream.next()).value).toMatchObject({ id: "1" });
  const pending = stream.next();
  abort.abort();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(true);
});

test("a refused stream surfaces the HTTP failure without reconnecting", async () => {
  const client = new Armada({
    token: "placeholder",
    fetch: async () => Response.json({ error: "forbidden" }, { status: 403 }),
  });
  await expect(client.events.stream({ sandbox }).next()).rejects.toMatchObject({ status: 403 });
});

test.each([["transport"], [429], [502], [503], [504]] as const)(
  "reconnects after a transient %s failure and honors Retry-After",
  async (failure) => {
    jest.useFakeTimers();
    let attempts = 0;
    const timer = observeRetryTimer();
    const client = new Armada({
      token: "placeholder",
      fetch: async () => {
        if (++attempts === 1) {
          if (failure === "transport") throw new TypeError("connection reset");
          return new Response(null, { status: failure, headers: { "retry-after": "3" } });
        }
        return new Response(frame("2"), { headers });
      },
    });
    const stream = client.events.stream({ sandbox, cursor: "1" });
    try {
      const pending = stream.next();
      await timer.scheduled();
      const delay = failure === "transport" ? 1000 : 3000;
      jest.advanceTimersByTime(delay - 1);
      await Promise.resolve();
      expect(attempts).toBe(1);
      jest.advanceTimersByTime(1);
      expect((await pending).value).toMatchObject({ id: "2" });
      expect(attempts).toBe(2);
    } finally {
      await stream.return();
      timer.restore();
      jest.useRealTimers();
    }
  },
);

test("return cancels a pending reconnect without waiting for Retry-After", async () => {
  jest.useFakeTimers();
  const timer = observeRetryTimer();
  let attempts = 0;
  let signal: AbortSignal | null | undefined;
  const client = new Armada({
    token: "placeholder",
    fetch: async (_url, init) => {
      signal = init?.signal;
      attempts++;
      return new Response(null, { status: 503, headers: { "retry-after": "3600" } });
    },
  });
  const stream = client.events.stream({ sandbox });
  try {
    const pending = stream.next();
    await timer.scheduled();
    const close = stream.return();
    expect(signal?.aborted).toBe(true);
    expect(await close).toEqual({ done: true, value: undefined });
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(attempts).toBe(1);
  } finally {
    timer.restore();
    jest.useRealTimers();
  }
});

function observeRetryTimer() {
  const spy = jest.spyOn(globalThis, "setTimeout");
  return {
    async scheduled() {
      for (let turn = 0; turn < 32 && spy.mock.calls.length === 0; turn++) await Promise.resolve();
      expect(spy).toHaveBeenCalled();
    },
    restore: () => spy.mockRestore(),
  };
}
