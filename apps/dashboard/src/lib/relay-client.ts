import type { RelayTicketResponse } from "@armada/core/contract";
import * as r from "@armada/core/relay";
import { sandboxUsesRuntime } from "./sandbox-thread.ts";

const { OPEN_PTY, OPEN_OK, DATA, CREDIT, RESIZE, CLOSE, PING, PONG } = r.RELAY_OPCODE;
const STREAM_ID = 1,
  MAX_QUEUED = 1_048_576,
  PORT_RE = /^[1-9]\d{0,4}$/,
  enc = new TextEncoder();

export const COMMON_PREVIEW_PORTS = [3000, 5173, 8080, 8000] as const;
export type RelayClientState = {
  phase:
    | "idle"
    | "minting"
    | "connecting"
    | "authenticating"
    | "opening"
    | "connected"
    | "reconnecting"
    | "disconnected"
    | "error";
  message?: string;
  canReconnect: boolean;
};
export type RelayConnectionPhase = RelayClientState["phase"];
export type RelayTimer = { after(ms: number, cb: () => void): () => void };
export type RelayWebSocketLike = {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason?: string }) => void): void;
};
export type RelayClientOptions = {
  mintTicket: () => Promise<{ ok: true; ticket: RelayTicketResponse } | { ok: false; error: string; code?: string }>;
  onState: (state: RelayClientState) => void;
  onData: (data: Uint8Array, ack: () => void) => void;
  cwd?: string;
  resizeDebounceMs?: number;
  createWebSocket?: (url: string) => RelayWebSocketLike;
  timer?: RelayTimer;
};

const tryOr = <T>(fn: () => T, fallback: T) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const defaultTimer: RelayTimer = {
  after: (ms, cb) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

export function parseRelayPort(raw: string) {
  const t = raw.trim();
  const n = PORT_RE.test(t) ? Number(t) : 0;
  return n >= 1 && n <= 65_535
    ? { ok: true as const, port: n }
    : { ok: false as const, error: "Enter a whole port number between 1 and 65535." };
}

export const portForwardCommand = (sandboxId: string, port: number) => `armada port-forward ${sandboxId} ${port}`;

export const canUseSandboxRelay = (s: {
  publicStatus: string;
  application_secret_tainted: boolean;
  stop_requested_at: string | null;
  deleted_at: string | null;
  provider: string | null;
  boat_runtime: boolean;
  runtime_transport: string | null;
}) =>
  !s.application_secret_tainted &&
  !s.stop_requested_at &&
  !s.deleted_at &&
  (s.publicStatus === "ready" || s.publicStatus === "running") &&
  sandboxUsesRuntime(s);

const CLOSE_INFO: Record<string, readonly ["disconnected" | "error", string, boolean]> = {
  eof: ["disconnected", "Shell exited.", true],
  revoked: ["error", "Relay access was revoked for this sandbox.", false],
  limit: ["error", "Too many open terminals on this sandbox. Close one and reconnect.", true],
  refused: ["error", "The sandbox refused to start a shell session.", true],
  timeout: ["error", "Terminal session timed out.", true],
  backpressure: ["error", "Terminal stream closed due to backpressure.", true],
};

export function describeRelayClose(code: number, reason?: string) {
  const hit =
    (reason && CLOSE_INFO[reason]) ||
    (code === 4403 ? CLOSE_INFO.revoked : code === 4429 ? CLOSE_INFO.limit : undefined);
  if (hit) return { phase: hit[0], message: hit[1], canReconnect: hit[2] };
  if (code === 4401)
    return { phase: "error" as const, message: "Relay ticket expired or was rejected.", canReconnect: true };
  if (code === 1012)
    return { phase: "disconnected" as const, message: "Sandbox relay disconnected.", canReconnect: true };
  if (code === 1000) return { phase: "disconnected" as const, message: "Disconnected.", canReconnect: true };
  return { phase: "error" as const, message: "Connection to sandbox relay dropped.", canReconnect: true };
}

export function submitPreviewBootstrap(bootstrapUrl: string, ticket: string, doc: Document = document) {
  const u = ticket ? tryOr(() => new URL(bootstrapUrl), null) : null;
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.search || u.username || u.password) return false;
  const form = Object.assign(doc.createElement("form"), {
    method: "POST",
    action: u.toString(),
    target: "_blank",
    rel: "noopener",
  });
  form.style.display = "none";
  form.appendChild(Object.assign(doc.createElement("input"), { type: "hidden", name: "ticket", value: ticket }));
  doc.body.appendChild(form);
  try {
    form.submit();
    return true;
  } finally {
    form.remove();
  }
}

const toBytes = (d: unknown) =>
  d instanceof Uint8Array
    ? d
    : ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : d instanceof ArrayBuffer
        ? new Uint8Array(d)
        : null;

export function createRelayClient(options: RelayClientOptions) {
  const timer = options.timer ?? defaultTimer,
    debounceMs = options.resizeDebounceMs ?? 60,
    createWs = options.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as RelayWebSocketLike);
  let state: RelayClientState = { phase: "idle", canReconnect: true },
    ws: RelayWebSocketLike | null = null,
    win = new r.StreamWindow(r.INITIAL_STREAM_WINDOW, r.CREDIT_WATERMARK),
    outQueue: Uint8Array[] = [],
    outQueued = 0,
    attempt = 0,
    desired = { cols: 80, rows: 24 },
    sent = { cols: 80, rows: 24 },
    cancelResize: (() => void) | null = null;

  const setState = (next: RelayClientState) => {
    state = next;
    options.onState(next);
  };
  const sendRaw = (p: string | Uint8Array) =>
    Boolean(
      ws &&
        ws.readyState === 1 &&
        tryOr(() => {
          ws!.send(p);
          return true;
        }, false),
    );
  const sendFrame = (m: r.RelayMessage) => sendRaw(r.encodeRelayMessage(m));
  const teardown = (sendClose: boolean, code = 1000) => {
    cancelResize?.();
    cancelResize = null;
    outQueue = [];
    outQueued = 0;
    const cur = ws;
    ws = null;
    if (!cur) return;
    if (sendClose && (state.phase === "opening" || state.phase === "connected") && cur.readyState === 1)
      tryOr(
        () => cur.send(r.encodeRelayMessage({ type: CLOSE, streamId: STREAM_ID, code: 1000, reason: "eof" })),
        undefined,
      );
    tryOr(() => cur.close(code), undefined);
  };
  const stop = (next: RelayClientState, code = 1000, sendClose = false) => {
    attempt += 1;
    teardown(sendClose, code);
    setState(next);
  };
  const flushOut = () => {
    if (state.phase !== "connected") return;
    while (outQueue.length && win.sendAvailable > 0) {
      const head = outQueue[0]!,
        size = Math.min(head.byteLength, r.MAX_DATA_CHUNK, win.sendAvailable);
      if (!win.consumeSend(size)) break;
      outQueued -= size;
      const chunk = size === head.byteLength ? head : head.subarray(0, size);
      if (size === head.byteLength) outQueue.shift();
      else outQueue[0] = head.subarray(size);
      if (!sendFrame({ type: DATA, streamId: STREAM_ID, data: chunk })) return;
    }
  };
  const sendResizeNow = () => {
    if (state.phase !== "connected" || (desired.cols === sent.cols && desired.rows === sent.rows)) return;
    sent = { ...desired };
    sendFrame({ type: RESIZE, streamId: STREAM_ID, ...sent });
  };

  async function connect(cols: number, rows: number, mode?: { reconnect?: boolean }) {
    const id = ++attempt;
    teardown(true);
    desired = r.clampTerminalSize(cols, rows);
    win = new r.StreamWindow(r.INITIAL_STREAM_WINDOW, r.CREDIT_WATERMARK);
    setState({ phase: mode?.reconnect ? "reconnecting" : "minting", canReconnect: false });
    const minted = await options
      .mintTicket()
      .catch(() => ({ ok: false as const, error: "Could not request a relay ticket.", code: undefined }));
    if (id !== attempt) return;
    if (!minted.ok)
      return setState({ phase: "error", message: minted.error, canReconnect: minted.code !== "forbidden" });
    setState({ phase: "connecting", canReconnect: false });
    ws = tryOr(() => {
      const s = createWs(minted.ticket.wsUrl);
      s.binaryType = "arraybuffer";
      return s;
    }, null);
    if (!ws) return setState({ phase: "error", message: "Could not open relay WebSocket.", canReconnect: true });
    const fail = (message = "Relay protocol error.", code = 1002) =>
      id === attempt && stop({ phase: "error", message, canReconnect: true }, code);
    ws.addEventListener("open", () => {
      if (id !== attempt) return;
      setState({ phase: "authenticating", canReconnect: false });
      if (!sendRaw(JSON.stringify({ type: "auth", ticket: minted.ticket.ticket })))
        fail("Could not authenticate relay session.");
    });
    ws.addEventListener("message", (ev) => {
      if (id !== attempt) return;
      if (state.phase === "authenticating") {
        const raw = ev.data;
        const ok =
          typeof raw === "string" && tryOr(() => (JSON.parse(raw) as { type?: unknown })?.type === "auth_ok", false);
        if (!ok) return void fail("Relay authentication was rejected.");
        sent = { ...desired };
        setState({ phase: "opening", canReconnect: false });
        if (!sendFrame({ type: OPEN_PTY, streamId: STREAM_ID, ...sent, ...(options.cwd ? { cwd: options.cwd } : {}) }))
          fail("Could not open terminal stream.");
        return;
      }
      const bytes = toBytes(ev.data);
      const msg = bytes ? tryOr(() => r.decodeRelayMessage(bytes), undefined) : undefined;
      if (!msg) return void fail();
      if (msg.type === PING) return void sendFrame({ type: PONG, ...(msg.nonce ? { nonce: msg.nonce } : {}) });
      if (msg.type === PONG) return;
      if (msg.type === CLOSE && (msg.streamId === 0 || msg.streamId === STREAM_ID))
        return stop(describeRelayClose(msg.code, msg.reason));
      if (msg.streamId !== STREAM_ID) return;
      if (msg.type === OPEN_OK) {
        setState({ phase: "connected", canReconnect: true });
        sendResizeNow();
        flushOut();
      } else if (msg.type === DATA && state.phase === "connected") {
        const len = msg.data.byteLength;
        if (!win.recordReceived(len)) {
          sendFrame({ type: CLOSE, streamId: STREAM_ID, code: 1008, reason: "backpressure" });
          return stop(describeRelayClose(1008, "backpressure"), 1008);
        }
        let acked = false;
        options.onData(msg.data, () => {
          if (acked || id !== attempt) return;
          acked = true;
          const grant = win.acknowledgeReceived(len);
          if (grant > 0) sendFrame({ type: CREDIT, streamId: STREAM_ID, bytes: grant });
        });
      } else if (msg.type === CREDIT) {
        if (
          !tryOr(() => {
            win.replenishSend(msg.bytes);
            return true;
          }, false)
        )
          return void fail();
        flushOut();
      }
    });
    ws.addEventListener("error", () => {
      if (id === attempt && (state.phase === "connecting" || state.phase === "authenticating"))
        fail("Could not reach the sandbox relay.", 1006);
    });
    ws.addEventListener("close", (ev) => {
      if (id === attempt) stop(describeRelayClose(ev.code, ev.reason));
    });
  }

  return {
    get state() {
      return state;
    },
    connect,
    sendInput(data: string | Uint8Array) {
      const b = typeof data === "string" ? enc.encode(data) : data;
      if (!b.byteLength || state.phase === "idle" || state.phase === "disconnected" || state.phase === "error") return;
      if (outQueued + b.byteLength > MAX_QUEUED) return;
      outQueue.push(b);
      outQueued += b.byteLength;
      flushOut();
    },
    resize(cols: number, rows: number) {
      const next = r.clampTerminalSize(cols, rows);
      if (next.cols === desired.cols && next.rows === desired.rows) return;
      desired = next;
      if (state.phase !== "connected") return;
      cancelResize?.();
      cancelResize = null;
      if (debounceMs <= 0) return sendResizeNow();
      cancelResize = timer.after(debounceMs, () => {
        cancelResize = null;
        sendResizeNow();
      });
    },
    disconnect: () => stop({ phase: "disconnected", message: "Disconnected.", canReconnect: true }, 1000, true),
  };
}
