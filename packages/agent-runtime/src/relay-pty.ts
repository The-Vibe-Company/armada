import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as r from "@armada/core/relay";
import { validateHarnessCwd } from "./cwd.ts";
import { validateExecEnvironment } from "./exec-env.ts";
import { githubRuntimeEnvironment } from "./github-tools.ts";
import type { ExecEnvironment } from "./protocol.ts";

const OP = r.RELAY_OPCODE;
export type SendFn = (m: r.RelayMessage) => void;
export type AfterFn = (ms: number, cb: () => void) => () => void;
export const defaultAfter: AfterFn = (ms, cb) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};
export function pumpOut(id: number, q: Uint8Array[], w: r.StreamWindow, send: SendFn, d?: Uint8Array) {
  if (d?.byteLength) {
    if (q.reduce((a, b) => a + b.byteLength, 0) + d.byteLength > r.INITIAL_STREAM_WINDOW * 2) return false;
    q.push(d.slice());
  }
  while (q.length && w.sendAvailable > 0) {
    const h = q[0]!;
    const n = Math.min(h.byteLength, r.MAX_DATA_CHUNK, w.sendAvailable);
    if (n <= 0 || !w.consumeSend(n)) break;
    if (n === h.byteLength) q.shift();
    else q[0] = h.subarray(n);
    send({ type: OP.DATA, streamId: id, data: n === h.byteLength ? h : h.subarray(0, n) });
  }
  return true;
}
export function ackIn(id: number, w: r.StreamWindow, n: number, send: SendFn) {
  const g = w.acknowledgeReceived(n);
  if (g > 0) send({ type: OP.CREDIT, streamId: id, bytes: g });
}
export type PtyCallbacks = { data(d: Uint8Array): void; exit(c: number): void; drain(): void };
export type PtyProcess = {
  pid: number;
  exited: Promise<number>;
  write(d: Uint8Array): number;
  resize(c: number, r: number): void;
  close(): void;
};
export type PtyHost = {
  spawn(cwd: string, env: Record<string, string>, cols: number, rows: number, cb: PtyCallbacks): PtyProcess;
  killGroup(pid: number, sig: NodeJS.Signals): void;
};
export type PtyEnvironmentOptions = {
  ghConfigDir?: string | undefined;
  githubToolsRoot?: string | undefined;
};
export function ptyShellArgs(env: Record<string, string>, hasBash = existsSync("/bin/bash")) {
  if (!hasBash) return ["/bin/sh", "-l"];
  if (env.BASH_ENV) return ["/bin/bash", "-l", "-c", '[ -r "$BASH_ENV" ] && . "$BASH_ENV"; exec /bin/bash -i'];
  return ["/bin/bash", "-l"];
}
export const nativePtyHost: PtyHost = {
  spawn(cwd, env, cols, rows, cb) {
    const p = Bun.spawn(ptyShellArgs(env), {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        name: "xterm-256color",
        data: (_t, d) => cb.data(d),
        exit: (_t, c) => cb.exit(c),
        drain: cb.drain,
      },
    });
    const t = p.terminal;
    if (!t) {
      p.kill("SIGKILL");
      throw Error("pty_terminal_unavailable");
    }
    return {
      pid: p.pid,
      exited: p.exited,
      write: (d) => (t.closed ? 0 : t.write(d)),
      resize: (c, rw) => !t.closed && t.resize(c, rw),
      close: () => !t.closed && t.close(),
    };
  },
  killGroup(pid, sig) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  },
};
export const ptyEnvironment = (execEnv: ExecEnvironment | undefined, options?: PtyEnvironmentOptions) => {
  const base = validateExecEnvironment(execEnv);
  const path = base.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (
    options?.ghConfigDir !== undefined &&
    (!isAbsolute(options.ghConfigDir) || resolve(options.ghConfigDir) !== options.ghConfigDir)
  )
    throw Error("invalid_exec_environment");
  return {
    ...base,
    PATH: path,
    ...(options?.ghConfigDir ? { GH_CONFIG_DIR: options.ghConfigDir } : {}),
    ...(options?.githubToolsRoot ? githubRuntimeEnvironment({ PATH: path }, options.githubToolsRoot) : {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
};
type Pty = {
  id: number;
  proc: PtyProcess;
  w: r.StreamWindow;
  out: Uint8Array[];
  input: Uint8Array[];
  exited: boolean;
  code?: number;
};
export class RelayPtyManager {
  readonly streams = new Map<number, Pty>();
  private readonly env: Record<string, string>;
  constructor(
    private readonly cwd: string,
    execEnv: ExecEnvironment | undefined,
    private readonly send: SendFn,
    private readonly host: PtyHost = nativePtyHost,
    private readonly after: AfterFn = defaultAfter,
    envOptions?: PtyEnvironmentOptions,
  ) {
    this.env = ptyEnvironment(execEnv, envOptions);
  }
  open(id: number, cols: number, rows: number, cwd?: string) {
    if (this.streams.has(id) || this.streams.size >= r.MAX_PTYS_PER_SANDBOX)
      return this.send({ type: OP.CLOSE, streamId: id, code: 0, reason: this.streams.has(id) ? "refused" : "limit" });
    const s: Pty = { id, proc: undefined!, w: new r.StreamWindow(), out: [], input: [], exited: false };
    try {
      const sz = r.clampTerminalSize(cols, rows);
      s.proc = this.host.spawn(validateHarnessCwd(cwd ?? this.cwd), { ...this.env }, sz.cols, sz.rows, {
        data: (d) => this.streams.get(id) === s && this.flushOut(s, d),
        exit: () => s.proc?.close(),
        drain: () => this.streams.get(id) === s && this.pumpIn(s),
      });
    } catch {
      return this.send({ type: OP.CLOSE, streamId: id, code: 0, reason: "refused" });
    }
    this.streams.set(id, s);
    this.send({ type: OP.OPEN_OK, streamId: id });
    void s.proc.exited
      .catch(() => 1)
      .then((c) => {
        s.exited = true;
        s.proc.close();
        if (this.streams.get(id) !== s) return;
        s.code = Number.isFinite(c) && c >= 0 ? Math.min(0xffff, Math.trunc(c)) : 0;
        this.flushOut(s);
      });
  }
  write(id: number, d: Uint8Array) {
    const s = this.streams.get(id);
    if (!s || s.exited) return;
    if (!s.w.recordReceived(d.byteLength)) return this.close(id, "backpressure");
    if (d.byteLength) this.pumpIn(s, d.slice());
  }
  credit(id: number, n: number) {
    const s = this.streams.get(id);
    if (!s) return;
    try {
      s.w.replenishSend(n);
      this.flushOut(s);
    } catch {
      this.close(id, "backpressure");
    }
  }
  resize(id: number, cols: number, rows: number) {
    const s = this.streams.get(id);
    if (!s || s.exited) return;
    try {
      const sz = r.validateTerminalSize(cols, rows);
      s.proc.resize(sz.cols, sz.rows);
    } catch {}
  }
  close(id: number, reason?: r.RelayCloseReason) {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    s.out.length = s.input.length = 0;
    s.proc.close();
    if (!s.exited) {
      const sig = (k: NodeJS.Signals) => {
        try {
          this.host.killGroup(s.proc.pid, k);
        } catch {}
      };
      sig("SIGHUP");
      const cancelKill = this.after(2_000, () => !s.exited && sig("SIGKILL"));
      void s.proc.exited.then(cancelKill, cancelKill);
    }
    if (reason) this.send({ type: OP.CLOSE, streamId: id, code: 0, reason });
  }
  closeAll() {
    for (const id of [...this.streams.keys()]) this.close(id);
  }
  private flushOut(s: Pty, d?: Uint8Array) {
    if (!pumpOut(s.id, s.out, s.w, this.send, d)) return this.close(s.id, "backpressure");
    if (s.code === undefined || s.out.length) return;
    this.streams.delete(s.id);
    this.send({ type: OP.CLOSE, streamId: s.id, code: s.code, reason: "eof" });
  }
  private pumpIn(s: Pty, chunk?: Uint8Array) {
    if (chunk) s.input.push(chunk);
    let total = 0;
    while (!s.exited && s.input.length) {
      const h = s.input[0]!;
      const n = s.proc.write(h);
      if (n <= 0) break;
      total += n;
      if (n >= h.byteLength) s.input.shift();
      else s.input[0] = h.subarray(n);
    }
    if (total > 0) ackIn(s.id, s.w, total, this.send);
  }
}
