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

test.each(["epoch", "revision", "shape"] as const)(
  "model access refuses %s corruption without a retry",
  async (kind) => {
    let calls = 0;
    const channel = new RuntimeDialout("https://armada.example", session, {
      ...clock(),
      socket() {
        throw Error("unused");
      },
      async fetch() {
        calls++;
        return Response.json({
          epoch: kind === "epoch" ? "2" : "1",
          access:
            kind === "shape"
              ? null
              : {
                  accessToken: "offline-access",
                  chatgptAccountId: "account",
                  chatgptPlanType: null,
                  revision: kind === "revision" ? -1 : 1,
                },
        });
      },
    });
    await expect(channel.modelAccess()).rejects.toThrow(
      kind === "epoch" ? "runtime_channel_revoked" : "invalid_runtime_model_access",
    );
    expect(calls).toBe(1);
  },
);

test.skipIf(process.platform !== "linux")(
  "dial-out executes bounded shell work and revocation kills its whole owned group before draining",
  async () => {
    const { watch } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const { groupState, processIdentity } = await import("../src/processes.ts");
    const root = await mkdtemp(join(tmpdir(), "dialout-exec-"));
    const journal = new Journal(join(root, "journal"), (value) => value);
    const driver: Driver = {
      start() {
        throw Error("no model required");
      },
      async close() {},
    };
    const runner = new Runner(
      journal,
      {
        token: session.runtimeToken,
        sandboxId: session.sandboxId,
        generation: session.epoch,
        expiresAt: Date.now() + 60000,
      },
      { codex: driver },
    );
    const socket = new Socket(),
      stop = new AbortController(),
      time = clock();
    const channel = new RuntimeDialout("https://armada.example", session, {
      ...time,
      socket: () => socket,
      async fetch(url, options) {
        if (url.pathname.endsWith("/results")) {
          const body = JSON.parse(options.body as string) as { requestId: string };
          return Response.json({ epoch: session.epoch, requestId: body.requestId });
        }
        return new Response(null, { status: 401 });
      },
    });
    let completed = deferred(),
      response: ReturnType<Response["clone"]> | undefined;
    const work = channel.run(
      async (request) => {
        const result = await runner.handleDialout(request, stop.signal);
        response = result.clone();
        completed.resolve();
        return result;
      },
      stop.signal,
      () => runner.close(),
    );
    const outcome = work.catch((error: unknown) => error);
    const command = (requestId: string, input: Record<string, unknown>) =>
      socket.message({
        type: "command",
        epoch: session.epoch,
        request: {
          version: 1,
          sandboxId: session.sandboxId,
          requestId,
          op: "exec",
          input: { sandboxId: session.sandboxId, cwd: root, ...input },
        },
      });
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      socket.open();
      command("sync-exec", { command: "printf DIALOUT_EXEC_OK", timeoutSeconds: 10 });
      await completed.promise;
      expect(await response?.json()).toMatchObject({
        version: 1,
        requestId: "sync-exec",
        result: { detached: false, exitCode: 0, stdout: "DIALOUT_EXEC_OK" },
      });
      completed = deferred();
      command("detached-refused", { command: "sleep 60", detached: true });
      await completed.promise;
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: "invalid_request" });
      completed = deferred();
      const started = deferred();
      watcher = watch(root, (_event, filename) => {
        if (filename === "started") started.resolve();
      });
      command("owned-exec", {
        command: "printf '%s' $$ > pid.tmp; mv pid.tmp started; sleep 60 & wait",
        timeoutSeconds: 60,
      });
      await started.promise;
      const pid = Number(await readFile(join(root, "started"), "utf8"));
      const identity = processIdentity(pid);
      expect(groupState(pid, identity)).toBe("live");
      socket.message({ type: "pong", epoch: "2" });
      expect(await outcome).toBeInstanceOf(RuntimeChannelRevoked);
      await completed.promise;
      expect(groupState(pid, identity)).toBe("gone");
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ result: { detached: false } });
      const late = await runner.handleDialout({
        version: 1,
        sandboxId: session.sandboxId,
        requestId: "late",
        op: "exec",
        input: { sandboxId: session.sandboxId, command: "printf SHOULD_NOT_RUN" },
      });
      expect(late.status).not.toBe(200);
    } finally {
      watcher?.close();
      stop.abort();
      await runner.close();
      await outcome;
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
