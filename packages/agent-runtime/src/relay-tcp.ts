import { createConnection } from "node:net";
import * as r from "@armada/core/relay";
import { ackIn, pumpOut, type SendFn } from "./relay-pty.ts";

const OP = r.RELAY_OPCODE;
export type LoopbackAddress = "127.0.0.1" | "::1";
export type TcpSocket = { write(d: Uint8Array): boolean; pause(): void; resume(): void; destroy(): void };
export type TcpCallbacks = {
  connect(): void;
  data(d: Uint8Array): void;
  drain(): void;
  end(): void;
  error(e: NodeJS.ErrnoException): void;
  close(): void;
};
export type TcpHost = { connect(host: LoopbackAddress, port: number, cb: TcpCallbacks): TcpSocket };
export const nativeTcpHost: TcpHost = {
  connect(host, port, cb) {
    const s = createConnection({ host, port });
    for (const k of ["connect", "data", "drain", "end", "close"] as const) s.on(k, cb[k]);
    s.on("error", (e) => cb.error(e as NodeJS.ErrnoException));
    return {
      write: (d) => s.write(d),
      pause: () => void s.pause(),
      resume: () => void s.resume(),
      destroy: () => void s.destroy(),
    };
  },
};
type Tcp = {
  id: number;
  port: number;
  w: r.StreamWindow;
  out: Uint8Array[];
  sock?: TcpSocket | undefined;
  state: 0 | 1 | 2;
  v6: boolean;
  paused: boolean;
  draining: number;
};
export class RelayTcpManager {
  readonly streams = new Map<number, Tcp>();
  constructor(
    private readonly send: SendFn,
    private readonly host: TcpHost = nativeTcpHost,
  ) {}
  open(id: number, port: number) {
    if (this.streams.has(id) || this.streams.size >= r.MAX_TCP_PER_SANDBOX)
      return this.send({ type: OP.CLOSE, streamId: id, code: 0, reason: this.streams.has(id) ? "refused" : "limit" });
    let valid: number;
    try {
      valid = r.validateRelayPort(port);
    } catch {
      return this.send({ type: OP.CLOSE, streamId: id, code: 0, reason: "refused" });
    }
    const s: Tcp = {
      id,
      port: valid,
      w: new r.StreamWindow(),
      out: [],
      state: 0,
      v6: false,
      paused: false,
      draining: 0,
    };
    this.streams.set(id, s);
    this.dial(s, "127.0.0.1");
  }
  write(id: number, d: Uint8Array) {
    const s = this.streams.get(id);
    if (!s?.sock || s.state !== 1) return;
    if (!s.w.recordReceived(d.byteLength)) return this.close(id, "backpressure");
    if (!d.byteLength) return;
    if (s.sock.write(d)) ackIn(id, s.w, d.byteLength, this.send);
    else s.draining += d.byteLength;
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
  close(id: number, reason?: r.RelayCloseReason) {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    s.out.length = 0;
    s.sock?.destroy();
    s.sock = undefined;
    if (reason) this.send({ type: OP.CLOSE, streamId: id, code: 0, reason });
  }
  closeAll() {
    for (const id of [...this.streams.keys()]) this.close(id);
  }
  private dial(s: Tcp, host: LoopbackAddress) {
    let cur: TcpSocket | undefined;
    const live = () => this.streams.get(s.id) === s && s.sock === cur;
    const eof = () => {
      if (!live()) return;
      s.state = 2;
      this.flushOut(s);
    };
    try {
      cur = this.host.connect(host, s.port, {
        connect: () => {
          if (!live()) return;
          s.state = 1;
          this.send({ type: OP.OPEN_OK, streamId: s.id });
        },
        data: (d) => live() && this.flushOut(s, d),
        drain: () => {
          if (!live() || !s.draining) return;
          ackIn(s.id, s.w, s.draining, this.send);
          s.draining = 0;
        },
        end: eof,
        close: () => (s.state ? eof() : live() && this.close(s.id, "refused")),
        error: (err) => {
          if (!live()) return;
          if (!s.state && !s.v6 && err.code === "ECONNREFUSED") {
            s.v6 = true;
            s.sock = undefined;
            cur?.destroy();
            return this.dial(s, "::1");
          }
          this.close(s.id, !s.state ? (err.code === "ETIMEDOUT" ? "timeout" : "refused") : "eof");
        },
      });
      s.sock = cur;
    } catch {
      this.close(s.id, "refused");
    }
  }
  private flushOut(s: Tcp, d?: Uint8Array) {
    if (!pumpOut(s.id, s.out, s.w, this.send, d)) return this.close(s.id, "backpressure");
    if (s.state === 2 && !s.out.length) return this.close(s.id, "eof");
    if (!s.sock || s.out.length > 0 === s.paused) return;
    s.paused = s.out.length > 0;
    if (s.paused) s.sock.pause();
    else s.sock.resume();
  }
}
