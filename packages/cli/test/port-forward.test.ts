import { expect, test } from "bun:test";
import { CREDIT_WATERMARK, INITIAL_STREAM_WINDOW, RELAY_OPCODE } from "@armada/core/relay";
import { run } from "../src/run.ts";
import { createFakeServer, createFakeSocket, createFakeWs, makeRelayAuth, sentBytes, TICKET } from "./relay.fixture.ts";

const ID = "22222222-2222-4222-8222-222222222222";

test("port-forward binds 127.0.0.1, multiplexes sockets over one WSS, enforces backpressure and tears down on SIGINT", async () => {
  const reqs: { url: string; body: unknown }[] = [];
  const { io, auth, getOut, getErr } = makeRelayAuth(async (u, init) => {
    reqs.push({ url: String(u), body: JSON.parse(String(init?.body)) });
    return Response.json(TICKET);
  });
  let wsCount = 0,
    srv!: ReturnType<typeof createFakeServer>;
  const ws = createFakeWs(),
    signals = new Map<string, () => void>(),
    { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const done = run(["port-forward", ID, "3000", "8080"], io, {
    auth,
    stdoutIsTTY: true,
    relay: {
      createWebSocket() {
        wsCount++;
        queueMicrotask(() => ws.open());
        return ws.ws;
      },
      createTcpServer(onConn) {
        srv = createFakeServer(onConn, markReady);
        return srv.server;
      },
      onSignal(sig, fn) {
        signals.set(sig, fn);
        return () => signals.delete(sig);
      },
    },
  });
  await ready;
  expect([wsCount, srv.state.bound]).toEqual([1, { host: "127.0.0.1", port: 8080 }]);
  expect(reqs).toEqual([
    { url: `https://armada.test/api/v1/sandboxes/${ID}/relay-ticket`, body: { mode: "tcp", port: 3000 } },
  ]);
  expect(getOut()).toContain(`127.0.0.1:8080 -> sandbox ${ID}:3000`);

  const s1 = createFakeSocket(),
    s2 = createFakeSocket();
  srv.accept(s1.socket);
  srv.accept(s2.socket);
  expect([s1.state.paused, s2.state.paused]).toEqual([true, true]);
  expect(ws.sent.slice(0, 2)).toEqual([
    { type: RELAY_OPCODE.OPEN_TCP, streamId: 1, port: 3000 },
    { type: RELAY_OPCODE.OPEN_TCP, streamId: 2, port: 3000 },
  ]);
  ws.receive({ type: RELAY_OPCODE.OPEN_OK, streamId: 1 });
  ws.receive({ type: RELAY_OPCODE.OPEN_OK, streamId: 2 });
  expect([s1.state.paused, s2.state.paused]).toEqual([false, false]);

  s1.emit("data", new Uint8Array(INITIAL_STREAM_WINDOW + 4));
  expect([s1.state.paused, sentBytes(ws.sent, 1)]).toEqual([true, INITIAL_STREAM_WINDOW]);
  ws.receive({ type: RELAY_OPCODE.CREDIT, streamId: 1, bytes: 1024 });
  expect([s1.state.paused, sentBytes(ws.sent, 1)]).toEqual([false, INITIAL_STREAM_WINDOW + 4]);

  s2.state.blockWrite = true;
  ws.receive({ type: RELAY_OPCODE.DATA, streamId: 2, data: new Uint8Array(32_768) });
  ws.receive({ type: RELAY_OPCODE.DATA, streamId: 2, data: new Uint8Array(32_768) });
  expect(ws.sent.some((m) => m.type === RELAY_OPCODE.CREDIT && m.streamId === 2)).toBe(false);
  s2.emit("drain");
  expect(ws.sent.at(-1)).toEqual({ type: RELAY_OPCODE.CREDIT, streamId: 2, bytes: CREDIT_WATERMARK });
  ws.receive({ type: RELAY_OPCODE.CLOSE, streamId: 2, code: 0, reason: "eof" });
  expect(s2.state.ended).toBe(true);

  signals.get("SIGINT")?.();
  expect([await done, srv.state.closed, s1.state.destroyed, ws.state.closedWith, getErr()]).toEqual([
    0,
    true,
    true,
    1000,
    "",
  ]);
  expect(ws.sent.some((m) => m.type === RELAY_OPCODE.CLOSE && m.streamId === 1)).toBe(true);
});

test("port-forward defaults local port to remote port and rejects invalid ports before HTTP", async () => {
  let reqs = 0;
  const { io, auth } = makeRelayAuth(
    async () => {
      reqs++;
      return Response.json(TICKET);
    },
    { ARMADA_SANDBOX: ID },
  );
  expect(await run(["port-forward", ID, "0"], io, { auth, stdoutIsTTY: true })).toBe(2);
  expect(await run(["port-forward", ID, "70000"], io, { auth, stdoutIsTTY: true })).toBe(2);
  expect(await run(["port-forward"], io, { auth, stdoutIsTTY: true })).toBe(2);
  expect(reqs).toBe(0);

  const ws = createFakeWs(),
    signals = new Map<string, () => void>(),
    { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  let srv!: ReturnType<typeof createFakeServer>;
  const done = run(["port-forward", "5173"], io, {
    auth,
    stdoutIsTTY: true,
    relay: {
      createWebSocket() {
        queueMicrotask(() => ws.open());
        return ws.ws;
      },
      createTcpServer(onConn) {
        srv = createFakeServer(onConn, markReady);
        return srv.server;
      },
      onSignal(sig, fn) {
        signals.set(sig, fn);
        return () => signals.delete(sig);
      },
    },
  });
  await ready;
  expect(srv.state.bound).toEqual({ host: "127.0.0.1", port: 5173 });
  signals.get("SIGTERM")?.();
  expect(await done).toBe(0);
});

test("port-forward supports --json, disambiguates numeric sandbox prefix, and gives actionable EADDRINUSE hint", async () => {
  const numericId = "12345678-1111-4111-8111-111111111111";
  const prefixAuth = makeRelayAuth(async (url) =>
    String(url).endsWith("/sandbox/list")
      ? Response.json({ sandboxes: [{ id: numericId }], hasMore: false, nextPage: null })
      : Response.json(TICKET),
  );
  const ws = createFakeWs(),
    signals = new Map<string, () => void>(),
    { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const done = run(["port-forward", "12345", "3000", "--json"], prefixAuth.io, {
    auth: prefixAuth.auth,
    stdoutIsTTY: true,
    relay: {
      createWebSocket() {
        queueMicrotask(() => ws.open());
        return ws.ws;
      },
      createTcpServer: (onConn) => createFakeServer(onConn, markReady).server,
      onSignal(sig, fn) {
        signals.set(sig, fn);
        return () => signals.delete(sig);
      },
    },
  });
  await ready;
  expect(JSON.parse(prefixAuth.getOut())).toEqual({
    host: "127.0.0.1",
    localPort: 3000,
    sandboxId: numericId,
    remotePort: 3000,
  });
  signals.get("SIGINT")?.();
  expect(await done).toBe(0);

  const busyErr = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  const busyAuth = makeRelayAuth(async () => Response.json(TICKET), { ARMADA_SANDBOX: ID });
  const wsBusy = createFakeWs();
  const exit = await run(["port-forward", "3000", "8080"], busyAuth.io, {
    auth: busyAuth.auth,
    stdoutIsTTY: true,
    relay: {
      createWebSocket() {
        queueMicrotask(() => wsBusy.open());
        return wsBusy.ws;
      },
      createTcpServer: (onConn) => createFakeServer(onConn, () => {}, busyErr).server,
      onSignal: () => () => {},
    },
  });
  expect(exit).toBe(1);
  expect(busyAuth.getErr()).toContain("choose a free local port");
  expect(busyAuth.getErr()).not.toContain("armada info --setup");
});
