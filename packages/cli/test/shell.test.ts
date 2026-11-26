import { expect, test } from "bun:test";
import { CREDIT_WATERMARK, INITIAL_STREAM_WINDOW, RELAY_OPCODE } from "@armada/core/relay";
import { run } from "../src/run.ts";
import { createFakeTerminal, createFakeWs, makeRelayAuth, sentBytes, TICKET } from "./relay.fixture.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("shell mints pty ticket, toggles raw TTY, handles resize, flow control, ping and exit code", async () => {
  const reqs: { url: string; body: unknown }[] = [];
  const { io, auth, getErr } = makeRelayAuth(
    async (u, init) => {
      reqs.push({ url: String(u), body: JSON.parse(String(init?.body)) });
      return Response.json(TICKET);
    },
    { ARMADA_SANDBOX: ID },
  );
  const ws = createFakeWs(),
    term = createFakeTerminal(true),
    { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  let wsUrl = "",
    wsHeaders: Record<string, string> = {};
  const done = run(["shell", "--cwd", "/workspace"], io, {
    auth,
    stdoutIsTTY: true,
    relay: {
      terminal: term.terminal,
      onSignal: () => () => {},
      createWebSocket(url, headers) {
        wsUrl = url;
        wsHeaders = headers;
        queueMicrotask(() => {
          ws.open();
          queueMicrotask(markReady);
        });
        return ws.ws;
      },
    },
  });
  await ready;
  expect(reqs).toEqual([
    { url: `https://armada.test/api/v1/sandboxes/${ID}/relay-ticket`, body: { mode: "pty", cwd: "/workspace" } },
  ]);
  expect([wsUrl, wsHeaders, term.rawCalls]).toEqual([
    TICKET.wsUrl,
    { Authorization: `Bearer ${TICKET.ticket}` },
    [true],
  ]);
  expect(ws.sent[0]).toEqual({ type: RELAY_OPCODE.OPEN_PTY, streamId: 1, cols: 100, rows: 40, cwd: "/workspace" });
  ws.receive({ type: RELAY_OPCODE.OPEN_OK, streamId: 1 });
  term.resize(132, 50);
  const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  ws.receive({ type: RELAY_OPCODE.PING, streamId: 0, nonce });
  expect(ws.sent.slice(1, 4)).toEqual([
    { type: RELAY_OPCODE.RESIZE, streamId: 1, cols: 100, rows: 40 },
    { type: RELAY_OPCODE.RESIZE, streamId: 1, cols: 132, rows: 50 },
    { type: RELAY_OPCODE.PONG, streamId: 0, nonce },
  ]);
  term.state.block = true;
  ws.receive({ type: RELAY_OPCODE.DATA, streamId: 1, data: new Uint8Array(32_768) });
  expect(ws.sent.some((m) => m.type === RELAY_OPCODE.CREDIT)).toBe(false);
  term.state.block = false;
  ws.receive({ type: RELAY_OPCODE.DATA, streamId: 1, data: new Uint8Array(32_768) });
  expect(ws.sent.at(-1)).toEqual({ type: RELAY_OPCODE.CREDIT, streamId: 1, bytes: CREDIT_WATERMARK });
  term.stdin(new Uint8Array(INITIAL_STREAM_WINDOW + 10));
  expect([term.state.paused > 0, sentBytes(ws.sent)]).toEqual([true, INITIAL_STREAM_WINDOW]);
  ws.receive({ type: RELAY_OPCODE.CREDIT, streamId: 1, bytes: 1024 });
  expect(sentBytes(ws.sent)).toBe(INITIAL_STREAM_WINDOW + 10);
  ws.receive({ type: RELAY_OPCODE.CLOSE, streamId: 1, code: 42, reason: "eof" });
  expect([await done, term.rawCalls, getErr()]).toEqual([42, [true, false], ""]);
});

test("shell restores TTY on refused stream and rejects bad args before HTTP", async () => {
  let reqs = 0;
  const { io, auth, getErr } = makeRelayAuth(async () => {
    reqs++;
    return Response.json(TICKET);
  });
  expect(await run(["shell", ID, "--cwd", "bad\0path"], io, { auth, stdoutIsTTY: true })).toBe(2);
  expect(await run(["shell", ID, "--ttl", "1h"], io, { auth, stdoutIsTTY: true })).toBe(2);
  expect(reqs).toBe(0);
  const ws = createFakeWs(),
    term = createFakeTerminal(true),
    { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const done = run(["shell", ID], io, {
    auth,
    stdoutIsTTY: true,
    relay: {
      terminal: term.terminal,
      onSignal: () => () => {},
      createWebSocket() {
        queueMicrotask(() => {
          ws.open();
          queueMicrotask(markReady);
        });
        return ws.ws;
      },
    },
  });
  await ready;
  ws.receive({ type: RELAY_OPCODE.CLOSE, streamId: 1, code: 4403, reason: "refused" });
  expect([await done, term.rawCalls]).toEqual([1, [true, false]]);
  expect(getErr()).toContain("refused");
});
