import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DialoutIo, enrolRuntime, RuntimeChannelRevoked, RuntimeDialout } from "../src/dialout.ts";
import { type Driver, Journal, Runner } from "../src/index.ts";
import type { RunnerRequest } from "../src/protocol.ts";

const session = { sandboxId: "logical", epoch: "1", runtimeToken: `armada_runtime_${"a".repeat(64)}` };
function clock() {
  const timers = new Set<{ ms: number; callback: () => void; repeat: boolean }>();
  const add = (ms: number, callback: () => void, repeat: boolean) => {
    const timer = { ms, callback, repeat };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  return {
    after: (ms: number, callback: () => void) => add(ms, callback, false),
    every: (ms: number, callback: () => void) => add(ms, callback, true),
    fire(ms: number) {
      for (const timer of [...timers])
        if (timer.ms === ms) {
          if (!timer.repeat) timers.delete(timer);
          timer.callback();
        }
    },
    timers,
  };
}
class Socket extends EventTarget {
  sent: unknown[] = [];
  terminated = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  terminate() {
    this.terminated = true;
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("enrolment consumes one HTTPS ticket exchange and refuses invalid/lost replies without retry", async () => {
  const token = `armada_enrol_${"b".repeat(64)}`;
  let requests = 0;
  const io: DialoutIo = {
    ...clock(),
    socket() {
      throw Error("unused");
    },
    async fetch(url, options) {
      requests++;
      expect(url.href).toBe("https://armada.example/api/runtime/enrol");
      expect(options.redirect).toBe("error");
      expect(options.credentials).toBe("omit");
      expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ ...session, configuration: { marker: "private-bootstrap" } });
    },
  };
  expect(await enrolRuntime({ serverUrl: "https://armada.example", enrolmentToken: token }, io)).toEqual({
    ...session,
    configuration: { marker: "private-bootstrap" },
  });
  expect(requests).toBe(1);
  for (const response of [
    Response.json({ ...session, epoch: "0", configuration: {} }),
    Response.json({ ...session, configuration: null }),
    new Response(null, { status: 401 }),
  ]) {
    let attempts = 0;
    await expect(
      enrolRuntime(
        { serverUrl: "https://armada.example", enrolmentToken: token },
        {
          ...io,
          async fetch() {
            attempts++;
            return response;
          },
        },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  }
  let attempts = 0;
  await expect(
    enrolRuntime(
      { serverUrl: "https://armada.example", enrolmentToken: token },
      {
        ...io,
        async fetch() {
          attempts++;
          throw Error("lost_response");
        },
      },
    ),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
  expect(() => new RuntimeDialout("http://armada.example", session, io)).toThrow("invalid_runtime_origin");
});

test("WebSocket heartbeat stays below 30s and missing pong falls back to credential-scoped HTTPS", async () => {
  const time = clock(),
    socket = new Socket(),
    stop = new AbortController();
  const polled = deferred();
  let socketUrl = "",
    socketHeaders: Record<string, string> = {};
  const channel = new RuntimeDialout("https://armada.example", session, {
    ...time,
    socket(url, headers) {
      socketUrl = url.href;
      socketHeaders = headers;
      return socket;
    },
    async fetch(url, options) {
      expect(url.pathname).toBe("/api/runtime/poll");
      expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${session.runtimeToken}`);
      expect(new Headers(options.headers).get("x-armada-runtime-epoch")).toBe("1");
      expect(options.redirect).toBe("error");
      expect(options.credentials).toBe("omit");
      polled.resolve();
      stop.abort();
      return Response.json({ epoch: "1", command: null });
    },
  });
  const work = channel.run(async () => {
    throw Error("no command expected");
  }, stop.signal);
  socket.open();
  expect(socketUrl).toBe("wss://armada.example/api/runtime/channel");
  expect(socketHeaders.authorization).toBe(`Bearer ${session.runtimeToken}`);
  time.fire(20000);
  expect(socket.sent.at(-1)).toEqual({ type: "ping", epoch: "1" });
  socket.message({ type: "pong", epoch: "1" });
  time.fire(20000); // Pong allowed another heartbeat, not a reconnect.
  expect(socket.terminated).toBe(false);
  time.fire(20000); // This heartbeat was not acknowledged.
  await polled.promise;
  await work;
  expect(socket.terminated).toBe(true);
  expect(time.timers.size).toBe(0);
});

test("lost result ACK is retried before polling and replayed command uses the real Runner receipt, not a second native turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "dialout-journal-"));
  const journal = new Journal(join(root, "journal"), (value) => value.replaceAll(session.runtimeToken, "***"));
  const socket = new Socket(),
    stop = new AbortController(),
    time = clock();
  let starts = 0,
    results = 0,
    polls = 0;
  const replies: unknown[] = [];
  const request: RunnerRequest = {
    version: 1,
    sandboxId: "logical",
    requestId: "stable-request",
    op: "prompt",
    input: { sandboxId: "logical", harness: "codex", text: "fixture" },
  };
  const io: DialoutIo = {
    ...time,
    socket: () => socket,
    async fetch(url, options) {
      const body = JSON.parse(String(options.body));
      if (url.pathname.endsWith("/results")) {
        results++;
        replies.push(body.body);
        if (results === 1) return new Response(null, { status: 503 });
        return Response.json({ epoch: "1", requestId: request.requestId });
      }
      if (url.pathname.endsWith("/events"))
        return Response.json({ acknowledgedSequence: body.events.at(-1)?.sequence ?? 0 });
      expect(url.pathname).toBe("/api/runtime/poll");
      expect(results).toBeGreaterThanOrEqual(2);
      if (++polls === 1) return Response.json({ epoch: "1", command: request });
      stop.abort();
      return Response.json({ epoch: "1", command: null });
    },
  };
  const channel = new RuntimeDialout("https://armada.example", session, io);
  const driver: Driver = {
    start() {
      starts++;
      return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
    },
    async close() {},
  };
  const runner = new Runner(
    journal,
    { sandboxId: "logical", generation: "1", token: session.runtimeToken, expiresAt: Date.now() + 60000 },
    { codex: driver, claude: driver },
    channel,
  );
  try {
    const work = channel.run(
      (command) =>
        runner.handle(
          new Request("http://runtime/v1", {
            method: "POST",
            headers: { "x-armada-runner-grant": session.runtimeToken },
            body: JSON.stringify(command),
          }),
        ),
      stop.signal,
    );
    socket.open();
    socket.message({ type: "command", epoch: "1", request });
    await work;
    await runner.flushOutbox();
    expect(starts).toBe(1);
    expect(results).toBe(3);
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]).toEqual(replies[2]);
    expect(journal.ack).toBeGreaterThan(0);
    expect(time.timers.size).toBe(0);
  } finally {
    stop.abort();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale WebSocket epoch and HTTP event revocation stop the channel without dispatching another command", async () => {
  for (const cause of ["frame", "events"] as const) {
    const socket = new Socket(),
      time = clock(),
      stop = new AbortController();
    let handled = 0;
    const channel = new RuntimeDialout("https://armada.example", session, {
      ...time,
      socket: () => socket,
      async fetch() {
        return new Response(null, { status: 401 });
      },
    });
    const work = channel.run(async () => {
      handled++;
      return Response.json({});
    }, stop.signal);
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    socket.open();
    if (cause === "frame")
      socket.message({
        type: "command",
        epoch: "2",
        request: { version: 1, sandboxId: "logical", requestId: "stale", op: "health" },
      });
    else
      await expect(channel.append({ sandboxId: "logical", generation: "1", events: [] })).rejects.toBeInstanceOf(
        RuntimeChannelRevoked,
      );
    expect(await outcome).toBeInstanceOf(RuntimeChannelRevoked);
    expect(handled).toBe(0);
    expect(socket.terminated).toBe(true);
    expect(time.timers.size).toBe(0);
  }
});

test("revocation closes native work before waiting for an in-flight command to drain", async () => {
  const socket = new Socket(),
    time = clock(),
    stop = new AbortController();
  const entered = deferred(),
    nativeStopped = deferred();
  let closed = false;
  const channel = new RuntimeDialout("https://armada.example", session, {
    ...time,
    socket: () => socket,
    async fetch() {
      return new Response(null, { status: 401 });
    },
  });
  const work = channel.run(
    async () => {
      entered.resolve();
      await nativeStopped.promise; // Native RPC only settles after the driver is closed.
      return Response.json({});
    },
    stop.signal,
    async () => {
      closed = true;
      nativeStopped.resolve();
    },
  );
  const outcome = work.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    socket.open();
    socket.message({
      type: "command",
      epoch: "1",
      request: { version: 1, sandboxId: "logical", requestId: "native-resume", op: "health" },
    });
    await entered.promise;
    socket.message({ type: "pong", epoch: "2" });
    expect(closed).toBe(true);
    expect(await outcome).toBeInstanceOf(RuntimeChannelRevoked);
    expect(socket.terminated).toBe(true);
  } finally {
    nativeStopped.resolve();
    stop.abort();
    await outcome;
  }
});

test("HTTPS fallback keeps its epoch alive while a native command is blocked and revocation tears it down", async () => {
  const time = clock(),
    stop = new AbortController(),
    entered = deferred(),
    nativeStopped = deferred();
  let closed = false,
    contacts = 0;
  const channel = new RuntimeDialout("https://armada.example", session, {
    ...time,
    socket() {
      throw Error("upgrade rejected");
    },
    async fetch(url, options) {
      if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (url.pathname.endsWith("/session")) {
        contacts++;
        return new Response(null, { status: 401 });
      }
      return Response.json({
        epoch: "1",
        command: { version: 1, sandboxId: "logical", requestId: "native-wait", op: "health" },
      });
    },
  });
  const work = channel.run(
    async () => {
      entered.resolve();
      await nativeStopped.promise;
      return Response.json({});
    },
    stop.signal,
    async () => {
      closed = true;
      nativeStopped.resolve();
    },
  );
  const outcome = work.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    expect([...time.timers].some((timer) => timer.ms === 20000 && timer.repeat)).toBe(true);
    time.fire(20000);
    expect(await outcome).toBeInstanceOf(RuntimeChannelRevoked);
    expect(contacts).toBe(1);
    expect(closed).toBe(true);
    expect(time.timers.size).toBe(0);
  } finally {
    stop.abort();
    nativeStopped.resolve();
    await outcome;
  }
});
