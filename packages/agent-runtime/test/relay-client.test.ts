import { expect, test } from "bun:test";
import * as r from "@armada/core/relay";
import { createRuntimeRelay, type RelaySocket, RuntimeRelayClient } from "../src/relay-client.ts";
import { type PtyCallbacks, type PtyProcess, ptyEnvironment, ptyShellArgs } from "../src/relay-pty.ts";
import type { LoopbackAddress, TcpCallbacks, TcpSocket } from "../src/relay-tcp.ts";

type FakePty = PtyProcess & {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  cb: PtyCallbacks;
  closed: boolean;
  written: number[];
  resizes: [number, number][];
  limit: number;
  finish(c: number): void;
  kill(s: NodeJS.Signals): void;
};
type FakeTcp = TcpSocket & {
  host: LoopbackAddress;
  port: number;
  cb: TcpCallbacks;
  paused: boolean;
  destroyed: boolean;
};

const OP = r.RELAY_OPCODE;
const session = { sandboxId: "sbx-1", epoch: "7", runtimeToken: `armada_runtime_${"a".repeat(64)}` };
const tick = () => Promise.resolve().then(() => {});
class Ws extends EventTarget implements RelaySocket {
  sent: r.RelayMessage[] = [];
  send = (d: Uint8Array) => void this.sent.push(r.decodeRelayMessage(d));
  terminate = () => {};
  open = () => this.dispatchEvent(new Event("open"));
  rx = (m: r.RelayMessage) => this.dispatchEvent(new MessageEvent("message", { data: r.encodeRelayMessage(m) }));
  close = (code: number) => this.dispatchEvent(new CloseEvent("close", { code }));
}
function harness(autoHup = true) {
  const timers = new Set<[number, () => void]>();
  const fire = (ms: number) => {
    for (const t of [...timers]) {
      if (t[0] !== ms) continue;
      timers.delete(t);
      t[1]();
    }
  };
  const sockets: { url: string; headers: Record<string, string>; ws: Ws }[] = [];
  const sigs: [number, NodeJS.Signals][] = [];
  const ptys: FakePty[] = [];
  const tcps: FakeTcp[] = [];
  let pid = 1000;
  const client = new RuntimeRelayClient("https://armada.example", session, {
    cwd: "/tmp",
    execEnv: { HOME: "/home/user", PATH: "/usr/bin:/bin" },
    io: {
      after: (ms, cb) => {
        const t: [number, () => void] = [ms, cb];
        timers.add(t);
        return () => void timers.delete(t);
      },
      socket: (u, headers) => {
        const ws = new Ws();
        sockets.push({ url: u.href, headers, ws });
        return ws;
      },
    },
    ptyHost: {
      spawn: (cwd, env, cols, rows, cb) => {
        const d = Promise.withResolvers<number>();
        const p = {
          pid: ++pid,
          cwd,
          env,
          cols,
          rows,
          cb,
          closed: false,
          written: [] as number[],
          resizes: [] as [number, number][],
          limit: Infinity,
          exited: d.promise,
          finish: (c: number) => {
            cb.exit(c);
            d.resolve(c);
          },
          write: (b: Uint8Array) => {
            const n = Math.min(b.byteLength, p.limit);
            if (n > 0) p.written.push(n);
            return n;
          },
          resize: (c: number, rw: number) => void p.resizes.push([c, rw]),
          close: () => {
            p.closed = true;
          },
          kill: (s: NodeJS.Signals) => (s === "SIGKILL" || (s === "SIGHUP" && autoHup)) && p.finish(0),
        };
        ptys.push(p);
        return p;
      },
      killGroup: (id, s) => {
        sigs.push([id, s]);
        ptys.find((p) => p.pid === id)?.kill(s);
      },
    },
    tcpHost: {
      connect: (host, port, cb) => {
        const s = {
          host,
          port,
          cb,
          paused: false,
          destroyed: false,
          write: () => true,
          pause: () => {
            s.paused = true;
          },
          resume: () => {
            s.paused = false;
          },
          destroy: () => {
            s.destroyed = true;
          },
        };
        tcps.push(s);
        return s;
      },
    },
  });
  return { timers, fire, sockets, ptys, sigs, tcps, client };
}

test("PTY lifecycle, env isolation, cwd check, resize, credit backpressure, exit, SIGHUP->SIGKILL", async () => {
  const h = harness(false);
  const stop = new AbortController();
  const run = h.client.run(stop.signal);
  const ws = h.sockets[0]!.ws;
  expect(h.sockets[0]!.url).toBe("wss://armada.example/api/runtime/relay");
  expect(h.sockets[0]!.headers.authorization).toBe(`Bearer ${session.runtimeToken}`);
  expect(h.sockets[0]!.headers["x-armada-runtime-epoch"]).toBe("7");
  ws.open();
  ws.rx({ type: OP.OPEN_PTY, streamId: 1, cols: 100, rows: 30, cwd: "/nonexistent/relay/path" });
  expect(ws.sent.pop()).toEqual({ type: OP.CLOSE, streamId: 1, code: 0, reason: "refused" });
  ws.rx({ type: OP.OPEN_PTY, streamId: 2, cols: 100, rows: 30, cwd: "/tmp" });
  const p = h.ptys[0]!;
  expect(ws.sent.pop()).toEqual({ type: OP.OPEN_OK, streamId: 2 });
  expect(p.env).toEqual({ HOME: "/home/user", PATH: "/usr/bin:/bin", TERM: "xterm-256color", COLORTERM: "truecolor" });
  ws.rx({ type: OP.RESIZE, streamId: 2, cols: 140, rows: 45 });
  p.limit = 10;
  ws.rx({ type: OP.DATA, streamId: 2, data: new Uint8Array(r.MAX_DATA_CHUNK).fill(65) });
  p.limit = Infinity;
  p.cb.drain();
  ws.rx({ type: OP.DATA, streamId: 2, data: new Uint8Array(r.MAX_DATA_CHUNK).fill(66) });
  expect(p.resizes).toEqual([[140, 45]]);
  expect(p.written[0]).toBe(10);
  expect(ws.sent.pop()).toEqual({ type: OP.CREDIT, streamId: 2, bytes: r.CREDIT_WATERMARK });
  ws.sent.length = 0;
  p.cb.data(new Uint8Array(r.INITIAL_STREAM_WINDOW + 100).fill(97));
  expect(ws.sent.length).toBe(r.INITIAL_STREAM_WINDOW / r.MAX_DATA_CHUNK);
  ws.rx({ type: OP.CREDIT, streamId: 2, bytes: 100 });
  const tail = ws.sent.at(-1);
  expect(tail?.type === OP.DATA && tail.data.byteLength).toBe(100);
  p.finish(7);
  await tick();
  expect(ws.sent.pop()).toEqual({ type: OP.CLOSE, streamId: 2, code: 7, reason: "eof" });
  ws.rx({ type: OP.OPEN_PTY, streamId: 3, cols: 80, rows: 24 });
  ws.rx({ type: OP.CLOSE, streamId: 3, code: 0, reason: "eof" });
  h.fire(2_000);
  expect(h.sigs).toEqual([
    [h.ptys[1]!.pid, "SIGHUP"],
    [h.ptys[1]!.pid, "SIGKILL"],
  ]);
  stop.abort();
  await run;
  expect(h.timers.size).toBe(0);
});

test("TCP loopback-only dialing, ::1 fallback on ECONNREFUSED, pause/resume, and limits", async () => {
  const h = harness();
  const stop = new AbortController();
  const run = h.client.run(stop.signal);
  const ws = h.sockets[0]!.ws;
  ws.open();
  ws.rx({ type: OP.OPEN_TCP, streamId: 10, port: 3000 });
  h.tcps[0]!.cb.error(Object.assign(Error("refused"), { code: "ECONNREFUSED" }));
  h.tcps[1]!.cb.connect();
  expect([h.tcps[0]!.host, h.tcps[0]!.destroyed, h.tcps[1]!.host, h.tcps[1]!.port]).toEqual([
    "127.0.0.1",
    true,
    "::1",
    3000,
  ]);
  expect(ws.sent.pop()).toEqual({ type: OP.OPEN_OK, streamId: 10 });
  ws.sent.length = 0;
  h.tcps[1]!.cb.data(new Uint8Array(r.INITIAL_STREAM_WINDOW + 16).fill(1));
  expect([h.tcps[1]!.paused, ws.sent.length]).toEqual([true, r.INITIAL_STREAM_WINDOW / r.MAX_DATA_CHUNK]);
  ws.rx({ type: OP.CREDIT, streamId: 10, bytes: 16 });
  expect(h.tcps[1]!.paused).toBe(false);
  ws.rx({ type: OP.OPEN_TCP, streamId: 11, port: 3001 });
  h.tcps[2]!.cb.error(Object.assign(Error("unreachable"), { code: "ENETUNREACH" }));
  expect([h.tcps.length, ws.sent.pop()]).toEqual([3, { type: OP.CLOSE, streamId: 11, code: 0, reason: "refused" }]);
  for (let i = 1; i <= r.MAX_PTYS_PER_SANDBOX; i++) ws.rx({ type: OP.OPEN_PTY, streamId: i, cols: 80, rows: 24 });
  ws.rx({ type: OP.OPEN_PTY, streamId: 99, cols: 80, rows: 24 });
  for (let i = 1; i < r.MAX_TCP_PER_SANDBOX; i++) ws.rx({ type: OP.OPEN_TCP, streamId: 100 + i, port: 4000 + i });
  ws.rx({ type: OP.OPEN_TCP, streamId: 199, port: 4999 });
  expect(ws.sent.find((m) => m.streamId === 99)).toEqual({ type: OP.CLOSE, streamId: 99, code: 0, reason: "limit" });
  expect(ws.sent.pop()).toEqual({ type: OP.CLOSE, streamId: 199, code: 0, reason: "limit" });
  stop.abort();
  await run;
  expect([h.tcps[1]!.destroyed, h.timers.size]).toEqual([true, 0]);
});

test("reconnect backoff 1s->10s, 20s heartbeat, 4401 teardown, builder opt-out", async () => {
  const h = harness();
  const stop = new AbortController();
  const run = h.client.run(stop.signal);
  for (const [i, delay] of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000].entries()) {
    h.sockets[i]!.ws.close(1006);
    await tick();
    expect([...h.timers].some((t) => t[0] === delay)).toBe(true);
    h.fire(delay);
    await tick();
  }
  const active = h.sockets.at(-1)!.ws;
  active.open();
  h.fire(20_000);
  const ping = active.sent.pop();
  expect(ping?.type).toBe(OP.PING);
  if (ping?.type === OP.PING) active.rx({ type: OP.PONG, streamId: 0, ...(ping.nonce ? { nonce: ping.nonce } : {}) });
  h.fire(20_000);
  h.fire(20_000);
  await tick();
  h.fire(1_000);
  await tick();
  const next = h.sockets.at(-1)!.ws;
  next.open();
  next.rx({ type: OP.OPEN_PTY, streamId: 1, cols: 80, rows: 24 });
  next.rx({ type: OP.OPEN_TCP, streamId: 2, port: 5000 });
  h.tcps[0]!.cb.connect();
  next.close(4401);
  await run;
  expect([h.client.revoked, h.ptys[0]!.closed, h.tcps[0]!.destroyed, h.timers.size]).toEqual([true, true, true, 0]);
  expect(h.sigs).toEqual([[h.ptys[0]!.pid, "SIGHUP"]]);
  expect(
    createRuntimeRelay("https://armada.example", session, { cwd: "/tmp", credentialFreeBuilder: true }),
  ).toBeUndefined();
  expect(createRuntimeRelay("https://armada.example", undefined, { cwd: "/tmp" })).toBeUndefined();
  expect(createRuntimeRelay("https://armada.example", session, { cwd: "/tmp" })).toBeInstanceOf(RuntimeRelayClient);
});

test("relay PTY preserves trusted BASH_ENV and GH_CONFIG_DIR and sources BASH_ENV after login profile", () => {
  const env = ptyEnvironment(
    { HOME: "/home/user", PATH: "/usr/bin:/bin" },
    { ghConfigDir: "/home/user/.armada/exec-transient/gh", githubToolsRoot: "/home/user/.armada/github-abc" },
  );
  expect(env).toEqual({
    HOME: "/home/user",
    PATH: "/home/user/.armada/github-abc/bin:/usr/bin:/bin",
    BASH_ENV: "/home/user/.armada/github-abc/shell-env.sh",
    GH_CONFIG_DIR: "/home/user/.armada/exec-transient/gh",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  expect(ptyShellArgs(env, true)).toEqual([
    "/bin/bash",
    "-l",
    "-c",
    '[ -r "$BASH_ENV" ] && . "$BASH_ENV"; exec /bin/bash -i',
  ]);
  expect(ptyShellArgs({ PATH: "/usr/bin:/bin" }, true)).toEqual(["/bin/bash", "-l"]);
  expect(ptyShellArgs(env, false)).toEqual(["/bin/sh", "-l"]);
  expect(() => ptyEnvironment({ HOME: "/home/user" }, { ghConfigDir: "relative/gh" })).toThrow(
    "invalid_exec_environment",
  );
  expect(() => ptyEnvironment({ HOME: "/home/user" }, { githubToolsRoot: "relative/root" })).toThrow(
    "github_tools_denied",
  );
});
