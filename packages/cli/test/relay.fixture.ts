import { decodeRelayMessage, encodeRelayMessage, RELAY_OPCODE, type RelayMessage } from "@armada/core/relay";
import type { AuthIo } from "../src/auth-commands.ts";
import type { RelayTcpServer, RelayTcpSocket, RelayTerminal, RelayWebSocket } from "../src/relay-session.ts";
import { memorySessionStore } from "../src/session.ts";

export const TICKET = {
  ticket: "relay_fixture_ticket",
  wsUrl: "wss://armada.test/api/v1/relay/ws",
  expiresAt: "2026-11-26T00:00:00.000Z",
};
export const sentBytes = (sent: readonly RelayMessage[], id?: number) =>
  sent.reduce(
    (n, m) => (m.type === RELAY_OPCODE.DATA && (id === undefined || m.streamId === id) ? n + m.data.byteLength : n),
    0,
  );

function bus() {
  const map = new Map<string, ((a: unknown) => void)[]>();
  return {
    on(ev: string, fn: (...args: never[]) => void) {
      map.set(ev, [...(map.get(ev) ?? []), fn as (a: unknown) => void]);
    },
    emit(ev: string, a?: unknown) {
      for (const fn of [...(map.get(ev) ?? [])]) fn(a);
    },
  };
}

export function createFakeWs() {
  const ev = bus(),
    sent: RelayMessage[] = [],
    state = { readyState: 0, closedWith: undefined as number | undefined };
  const ws: RelayWebSocket = {
    get readyState() {
      return state.readyState;
    },
    binaryType: "blob",
    addEventListener: ev.on,
    send: (d) => void sent.push(decodeRelayMessage(d)),
    close(code = 1000) {
      if (state.readyState === 3) return;
      state.readyState = 3;
      state.closedWith = code;
      ev.emit("close", { code, reason: "" });
    },
  };
  return {
    ws,
    sent,
    state,
    open() {
      state.readyState = 1;
      ev.emit("open");
    },
    receive: (m: RelayMessage) => ev.emit("message", { data: encodeRelayMessage(m) }),
  };
}

export function createFakeTerminal(isTTY: boolean) {
  const rawCalls: boolean[] = [],
    written: Uint8Array[] = [],
    ev = bus(),
    state = { paused: 0, block: false };
  const terminal: RelayTerminal = {
    isTTY,
    columns: 100,
    rows: 40,
    setRawMode: (m) => void rawCalls.push(m),
    pause: () => void state.paused++,
    resume: () => {},
    writeStdout(c) {
      written.push(new Uint8Array(c));
      return !state.block;
    },
    onStdoutDrain(fn) {
      ev.on("drain", fn);
      return () => {};
    },
    onStdinData(fn) {
      ev.on("data", fn);
      return () => {};
    },
    onStdinEnd(fn) {
      ev.on("end", fn);
      return () => {};
    },
    onResize(fn) {
      ev.on("resize", ([c, r]: [number, number]) => fn(c, r));
      return () => {};
    },
  };
  return {
    terminal,
    rawCalls,
    written,
    state,
    stdin: (d: Uint8Array) => ev.emit("data", d),
    endStdin: () => ev.emit("end"),
    drain: () => ev.emit("drain"),
    resize: (c: number, r: number) => ev.emit("resize", [c, r]),
  };
}

export function createFakeSocket() {
  const ev = bus(),
    written: Uint8Array[] = [],
    state = { paused: false, ended: false, destroyed: false, blockWrite: false };
  const socket: RelayTcpSocket = {
    on: ev.on,
    write(c) {
      written.push(new Uint8Array(c));
      return !state.blockWrite;
    },
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
    },
    end() {
      state.ended = true;
    },
    destroy() {
      state.destroyed = true;
    },
  };
  return { socket, state, written, emit: ev.emit };
}

export function createFakeServer(
  onConn: (s: RelayTcpSocket) => void,
  onListen: () => void,
  listenError?: NodeJS.ErrnoException,
) {
  const ev = bus(),
    state = { bound: undefined as { host: string; port: number } | undefined, closed: false };
  const server: RelayTcpServer = {
    listen(port, host, cb) {
      if (listenError) {
        queueMicrotask(() => ev.emit("error", listenError));
        return;
      }
      state.bound = { host, port };
      cb();
      queueMicrotask(onListen);
    },
    address: () => (state.bound ? { address: state.bound.host, port: state.bound.port } : null),
    close(cb) {
      state.closed = true;
      cb?.();
    },
    on: ev.on,
  };
  return { server, state, accept: onConn };
}

export function makeRelayAuth(fetchFn: AuthIo["fetch"], env: Record<string, string> = {}) {
  const out: string[] = [],
    err: string[] = [];
  const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };
  const auth: AuthIo = {
    ...io,
    env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture_tok", ...env },
    session: memorySessionStore(),
    now: () => new Date(0),
    open: () => {},
    fetch: fetchFn,
  };
  return { io, auth, getOut: () => out.join(""), getErr: () => err.join("") };
}
