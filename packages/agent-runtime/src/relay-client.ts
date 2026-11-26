import * as r from "@armada/core/relay";
import type { ExecEnvironment } from "./protocol.ts";
import { type AfterFn, defaultAfter, nativePtyHost, type PtyHost, RelayPtyManager } from "./relay-pty.ts";
import { nativeTcpHost, RelayTcpManager, type TcpHost } from "./relay-tcp.ts";

const OP = r.RELAY_OPCODE;
export type RelaySession = { sandboxId: string; epoch: string; runtimeToken: string };
export interface RelaySocket extends EventTarget {
  send(d: Uint8Array): void;
  terminate(): void;
}
export type RelayIo = { socket(url: URL, headers: Record<string, string>): RelaySocket; after: AfterFn };
export type RelayClientOptions = {
  cwd: string;
  execEnv?: ExecEnvironment | undefined;
  ghConfigDir?: string | undefined;
  githubToolsRoot?: string | undefined;
  io?: RelayIo | undefined;
  ptyHost?: PtyHost | undefined;
  tcpHost?: TcpHost | undefined;
};
export const nativeRelayIo: RelayIo = {
  socket: (url, headers) => Object.assign(new WebSocket(url, { headers }), { binaryType: "arraybuffer" as const }),
  after: defaultAfter,
};
export class RuntimeRelayClient {
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly io: RelayIo;
  private readonly pty: RelayPtyManager;
  private readonly tcp: RelayTcpManager;
  private readonly terminated = new AbortController();
  private sock?: RelaySocket | undefined;
  private onErr?: (() => void) | undefined;
  private seq = 0;

  constructor(serverUrl: string, session: RelaySession, options: RelayClientOptions) {
    const u = new URL(serverUrl);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
      throw Error("invalid_runtime_origin");
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sandboxId) ||
      !/^[1-9][0-9]{0,18}$/.test(session.epoch) ||
      !/^armada_runtime_[a-f0-9]{64}$/.test(session.runtimeToken)
    )
      throw Error("invalid_runtime_session");
    this.url = new URL("/api/runtime/relay", u);
    this.url.protocol = "wss:";
    this.headers = { authorization: `Bearer ${session.runtimeToken}`, "x-armada-runtime-epoch": session.epoch };
    this.io = options.io ?? nativeRelayIo;
    const send = (m: r.RelayMessage) => this.sendFrame(m);
    this.pty = new RelayPtyManager(
      options.cwd,
      options.execEnv,
      send,
      options.ptyHost ?? nativePtyHost,
      this.io.after,
      { ghConfigDir: options.ghConfigDir, githubToolsRoot: options.githubToolsRoot },
    );
    this.tcp = new RelayTcpManager(send, options.tcpHost ?? nativeTcpHost);
  }
  get revoked() {
    return this.terminated.signal.aborted;
  }
  close() {
    this.terminated.abort();
    this.sock?.terminate();
    this.sock = undefined;
    this.tcp.closeAll();
    this.pty.closeAll();
  }
  async run(stop: AbortSignal) {
    const signal = AbortSignal.any([stop, this.terminated.signal]);
    let backoff = 1_000;
    while (!signal.aborted) {
      if (await this.connectOnce(signal)) backoff = 1_000;
      if (signal.aborted) break;
      await new Promise<void>((res) => {
        const done = () => {
          cancel();
          signal.removeEventListener("abort", done);
          res();
        };
        const cancel = this.io.after(backoff, done);
        signal.addEventListener("abort", done, { once: true });
      });
      backoff = Math.min(backoff * 2, 10_000);
    }
    this.tcp.closeAll();
    this.pty.closeAll();
  }
  private sendFrame(m: r.RelayMessage) {
    if (!this.sock) return;
    try {
      this.sock.send(r.encodeRelayMessage(m));
    } catch {
      this.onErr?.();
    }
  }
  private async connectOnce(signal: AbortSignal) {
    let socket: RelaySocket;
    try {
      socket = this.io.socket(this.url, this.headers);
    } catch {
      return false;
    }
    let opened = false,
      awaitingPong = false,
      nonce: Uint8Array | undefined,
      stopHb = () => {},
      stopConnect = () => {},
      finish = () => {};
    const armHb = () => {
      stopHb = this.io.after(20_000, () => {
        if (awaitingPong) return finish();
        awaitingPong = true;
        nonce = new Uint8Array(8);
        new DataView(nonce.buffer).setBigUint64(0, BigInt(++this.seq), false);
        this.sendFrame({ type: OP.PING, streamId: 0, nonce });
        armHb();
      });
    };
    const handlers: Record<string, EventListener> = {
      open: () => {
        opened = true;
        stopConnect();
        this.sock = socket;
        this.onErr = finish;
        armHb();
      },
      message: (e) => {
        const raw = (e as MessageEvent).data;
        if (!(raw instanceof Uint8Array || raw instanceof ArrayBuffer)) return finish();
        let m: r.RelayMessage;
        try {
          m = r.decodeRelayMessage(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
        } catch {
          return finish();
        }
        if (m.type === OP.PONG) {
          if (!nonce || !m.nonce || Buffer.compare(nonce, m.nonce) === 0) awaitingPong = false;
        } else if (m.type === OP.PING)
          this.sendFrame({ type: OP.PONG, streamId: 0, ...(m.nonce ? { nonce: m.nonce } : {}) });
        else this.dispatch(m, finish);
      },
      close: (e) => {
        if ([4401, 4403].includes((e as CloseEvent).code)) this.terminated.abort();
        finish();
      },
      error: () => finish(),
    };
    try {
      await new Promise<void>((resolve) => {
        let done = false;
        finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        stopConnect = this.io.after(8_000, finish);
        for (const [k, fn] of Object.entries(handlers)) socket.addEventListener(k, fn);
        signal.addEventListener("abort", finish, { once: true });
      });
    } finally {
      stopConnect();
      stopHb();
      this.sock = this.onErr = undefined;
      signal.removeEventListener("abort", finish);
      for (const [k, fn] of Object.entries(handlers)) socket.removeEventListener(k, fn);
      socket.terminate();
      this.tcp.closeAll();
      this.pty.closeAll();
    }
    return opened;
  }
  private dispatch(m: r.RelayMessage, disconnect: () => void) {
    const p = this.pty.streams;
    const t = this.tcp.streams;
    if (m.type === OP.OPEN_PTY || m.type === OP.OPEN_TCP) {
      if (p.has(m.streamId) || t.has(m.streamId))
        return this.sendFrame({ type: OP.CLOSE, streamId: m.streamId, code: 0, reason: "refused" });
      if (m.type === OP.OPEN_PTY) this.pty.open(m.streamId, m.cols, m.rows, m.cwd);
      else this.tcp.open(m.streamId, m.port);
    } else if (m.type === OP.DATA) (p.has(m.streamId) ? this.pty : this.tcp).write(m.streamId, m.data);
    else if (m.type === OP.CREDIT) (p.has(m.streamId) ? this.pty : this.tcp).credit(m.streamId, m.bytes);
    else if (m.type === OP.RESIZE) this.pty.resize(m.streamId, m.cols, m.rows);
    else if (m.type === OP.CLOSE) {
      if (m.streamId === 0) {
        if (m.reason === "revoked") this.terminated.abort();
        return disconnect();
      }
      (p.has(m.streamId) ? this.pty : this.tcp).close(m.streamId);
    }
  }
}
export const createRuntimeRelay = (
  serverUrl: string,
  session: RelaySession | undefined,
  options: RelayClientOptions & { credentialFreeBuilder?: boolean | undefined },
) => (session && !options.credentialFreeBuilder ? new RuntimeRelayClient(serverUrl, session, options) : undefined);
