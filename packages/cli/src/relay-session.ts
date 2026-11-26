import { AuthError } from "@armada/auth";
import { type ListResult, relayTicketResponse } from "@armada/core/contract";
import * as r from "@armada/core/relay";
import { uuid } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { resolveSandboxId } from "./current-sandbox.ts";
import type { Deps } from "./run.ts";
import { createSdkCommandClient } from "./sdk-session.ts";

const { CREDIT, DATA, PING, PONG } = r.RELAY_OPCODE;
export type RelayWebSocket = {
  readonly readyState: number;
  binaryType: string;
  send(d: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason?: string }) => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
};
export type RelayTcpSocket = {
  write(c: Uint8Array): boolean;
  pause(): void;
  resume(): void;
  end(): void;
  destroy(): void;
  on(ev: "data", fn: (chunk: Uint8Array) => void): void;
  on(ev: "drain" | "close", fn: () => void): void;
  on(ev: "error", fn: (err: Error) => void): void;
};
export type RelayTcpServer = {
  listen(port: number, host: string, cb: () => void): void;
  address(): { address: string; port: number } | string | null;
  close(cb?: () => void): void;
  on(ev: "error", fn: (err: Error) => void): void;
};
export type RelayTerminal = {
  readonly isTTY: boolean;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  setRawMode?: ((mode: boolean) => void) | undefined;
  pause?(): void;
  resume?(): void;
  writeStdout(c: Uint8Array): boolean;
  onStdoutDrain(fn: () => void): () => void;
  onStdinData(fn: (c: Uint8Array) => void): () => void;
  onStdinEnd?(fn: () => void): () => void;
  onResize(fn: (cols: number, rows: number) => void): () => void;
};
export type RelayDeps = {
  createWebSocket?: (url: string, headers: Record<string, string>) => RelayWebSocket;
  createTcpServer?: (onConn: (socket: RelayTcpSocket) => void) => RelayTcpServer;
  terminal?: RelayTerminal;
  onSignal?: (signal: "SIGINT" | "SIGTERM", fn: () => void) => () => void;
  connectTimeoutMs?: number;
  after?: (ms: number, fn: () => void) => () => void;
};
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const defaultAfter = (ms: number, fn: () => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
export type RelaySession = {
  readonly sandboxId: string;
  send(m: r.RelayMessage): boolean;
  start(h: { onMessage: (m: r.RelayMessage) => void; onClose: (code: number, reason: string) => void }): void;
  close(code?: number): void;
};

export const defaultOnSignal = (sig: "SIGINT" | "SIGTERM", fn: () => void) => {
  process.on(sig, fn);
  return () => void process.off(sig, fn);
};
const toBytes = (d: unknown) => {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return d instanceof ArrayBuffer ? new Uint8Array(d) : null;
};

export function createRelayPipe(
  session: RelaySession,
  streamId: number,
  io: { write: (d: Uint8Array) => boolean; pause?: () => void; resume?: () => void; onViolation: () => void },
) {
  const win = new r.StreamWindow(r.INITIAL_STREAM_WINDOW, r.CREDIT_WATERMARK),
    queue: Uint8Array[] = [];
  let queued = 0,
    paused = false,
    opened = false,
    closed = false,
    pendingAck = 0;
  const setPaused = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    (next ? io.pause : io.resume)?.();
  };
  const ack = (n: number) => {
    const grant = !closed && n > 0 ? win.acknowledgeReceived(n) : 0;
    if (grant > 0) session.send({ type: CREDIT, streamId, bytes: grant });
  };
  const flush = () => {
    while (opened && !closed && queue.length && win.sendAvailable > 0) {
      const head = queue[0]!,
        size = Math.min(head.byteLength, r.MAX_DATA_CHUNK, win.sendAvailable);
      if (!win.consumeSend(size)) break;
      queued -= size;
      if (size === head.byteLength) queue.shift();
      else queue[0] = head.subarray(size);
      session.send({ type: DATA, streamId, data: size === head.byteLength ? head : head.subarray(0, size) });
    }
    if (opened && !closed && !queued && win.sendAvailable > 0) setPaused(false);
  };
  const fail = () => {
    closed = true;
    io.onViolation();
  };
  return {
    get opened() {
      return opened;
    },
    pauseSource: () => setPaused(true),
    markOpened: () => {
      opened = true;
      flush();
    },
    push(chunk: Uint8Array) {
      if (closed || !chunk.byteLength) return;
      queue.push(chunk);
      queued += chunk.byteLength;
      flush();
      if (!closed && queued > 0) setPaused(true);
    },
    onData(data: Uint8Array) {
      if (closed) return;
      if (!win.recordReceived(data.byteLength)) return fail();
      if (io.write(data)) {
        const total = pendingAck + data.byteLength;
        pendingAck = 0;
        ack(total);
      } else pendingAck += data.byteLength;
    },
    onDrain() {
      if (closed || !pendingAck) return;
      const n = pendingAck;
      pendingAck = 0;
      ack(n);
    },
    onCredit(bytes: number) {
      if (closed) return;
      try {
        win.replenishSend(bytes);
      } catch {
        return fail();
      }
      flush();
    },
    flush,
    stop() {
      closed = true;
    },
  };
}

export async function openRelaySession(input: {
  auth: AuthIo;
  deps: Deps;
  explicitSandboxId?: string | undefined;
  org?: string | undefined;
  mode: "pty" | "tcp";
  port?: number | undefined;
  cwd?: string | undefined;
}) {
  const client = await createSdkCommandClient(
    { ...input.auth, fetch: input.deps.fetch ?? input.auth.fetch },
    { preserveServerErrors: true },
  );
  const sandboxId = await resolveSandboxId(
    input.explicitSandboxId,
    input.auth.env,
    input.deps.sandboxFile,
    input.org,
    client.sandboxes.list<ListResult>,
  );
  uuid(sandboxId, "sandbox id");
  const raw = await client.request<unknown>(`/api/v1/sandboxes/${sandboxId}/relay-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: input.mode,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.org !== undefined ? { org: input.org } : {}),
    }),
  });
  const ticket = relayTicketResponse.safeParse(raw);
  if (!ticket.success) throw new AuthError("Armada returned an invalid relay ticket response.", "unavailable");
  const headers = { Authorization: `Bearer ${ticket.data.ticket}` };
  const ws = input.deps.relay?.createWebSocket
    ? input.deps.relay.createWebSocket(ticket.data.wsUrl, headers)
    : (new WebSocket(ticket.data.wsUrl, { headers } as never) as unknown as RelayWebSocket);
  ws.binaryType = "arraybuffer";

  let opened = false,
    closed = false,
    closedEvent: { code: number; reason: string } | undefined,
    handlers: { onMessage: (m: r.RelayMessage) => void; onClose: (code: number, reason: string) => void } | undefined;
  const queued: r.RelayMessage[] = [];
  const sendRaw = (b: Uint8Array) => {
    if (closed || ws.readyState !== 1) return false;
    try {
      ws.send(b);
      return true;
    } catch {
      return false;
    }
  };
  const closeWs = (code = 1000) => {
    if (closed) return;
    closed = true;
    try {
      ws.close(code);
    } catch {}
  };
  const notifyClose = (code: number, reason: string) => {
    if (closedEvent) return;
    closed = true;
    closedEvent = { code, reason };
    handlers?.onClose(code, reason);
  };
  await new Promise<void>((resolve, reject) => {
    let cancelTimer: (() => void) | undefined;
    const clearTimer = () => {
      cancelTimer?.();
      cancelTimer = undefined;
    };
    const abort = (msg: string) => {
      if (opened || closed) return;
      clearTimer();
      closed = true;
      try {
        ws.close(1000);
      } catch {}
      reject(new AuthError(msg, "unavailable"));
    };
    const after = input.deps.relay?.after ?? defaultAfter;
    const timeoutMs = input.deps.relay?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    cancelTimer = after(timeoutMs, () => abort("Timed out connecting to sandbox relay."));
    ws.addEventListener("open", () => {
      if (opened || closed) return;
      clearTimer();
      opened = true;
      resolve();
    });
    ws.addEventListener("error", () => !opened && abort("Could not connect to sandbox relay."));
    ws.addEventListener("close", (ev: { code: number; reason?: string }) =>
      opened ? notifyClose(ev.code, ev.reason ?? "") : abort(`Sandbox relay closed before ready (${ev.code}).`),
    );
    ws.addEventListener("message", (ev: { data: unknown }) => {
      if (closed) return;
      const bytes = toBytes(ev.data);
      let msg: r.RelayMessage | undefined;
      if (bytes) {
        try {
          msg = r.decodeRelayMessage(bytes);
        } catch {}
      }
      if (!msg) {
        closeWs(1002);
        return notifyClose(1002, "protocol_error");
      }
      if (msg.type === PING)
        return void sendRaw(r.encodeRelayMessage({ type: PONG, ...(msg.nonce ? { nonce: msg.nonce } : {}) }));
      if (msg.type === PONG) return;
      if (handlers) handlers.onMessage(msg);
      else queued.push(msg);
    });
  });
  return {
    sandboxId,
    send: (m) => sendRaw(r.encodeRelayMessage(m)),
    start(next) {
      handlers = next;
      while (queued.length && !closedEvent) next.onMessage(queued.shift()!);
      if (closedEvent) next.onClose(closedEvent.code, closedEvent.reason);
    },
    close: closeWs,
  } satisfies RelaySession;
}
