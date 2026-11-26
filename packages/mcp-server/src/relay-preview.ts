import { createHash, randomBytes } from "node:crypto";
import { BodyTooLargeError, readBoundedText } from "@armada/auth";
import {
  CREDIT_WATERMARK,
  INITIAL_STREAM_WINDOW,
  MAX_DATA_CHUNK,
  type RelayCloseReason,
  StreamWindow,
} from "@armada/core/relay";
import { decryptSecret, encryptSecret } from "@armada/core/server";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import { AuthUnavailable, type CallerResult } from "./caller.ts";
import type { LocalTcpStream, RelayClock, RelayHub } from "./relay-hub.ts";

const COOKIE_NAME = "armada_preview";
const COOKIE_PREFIX = "armada_prev_";
const PREVIEW_TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 30_000;
const WS_OPEN_GRACE_MS = 5_000;
const MAX_HEADER_BYTES = 65_536;
const MAX_ENTER_BYTES = 16_384;
export const PREVIEW_WS_MAX_PAYLOAD = 4 * 1024 * 1024;
const ENTER_PATH = "/api/v1/relay/preview/enter";
const PREVIEW_RE = /^\/api\/v1\/sandboxes\/([^/]+)\/ports\/([^/]+)(\/.*)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORT_RE = /^[1-9]\d{0,4}$/;
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASON_RE = /^[\t \x21-\x7e\x80-\xff]*$/;
const hasBadHeaderChar = (s: string) => s.includes("\0") || s.includes("\r") || s.includes("\n");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const NULL_BODY = new Set([204, 205, 304]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CRLF = new Uint8Array([13, 10]);
const CRLF2 = new Uint8Array([13, 10, 13, 10]);
const EMPTY_U8 = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();

const cookieSchema = z.strictObject({
  purpose: z.literal("sandbox-preview-v1"),
  sandboxId: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  epoch: z.string().min(1),
  userId: z.string().min(1),
  orgIds: z.array(z.string().min(1)).min(1),
  exp: z.number().finite(),
});
type PreviewCookie = z.infer<typeof cookieSchema>;
export type PreviewWsSocketData = { kind: "preview-ws"; id: number };
export type RelayPreviewOptions = {
  relayHub: RelayHub;
  encryptionKey: string | undefined;
  publicUrl: string;
  authenticate?: (request: Request) => Promise<CallerResult>;
  clock?: RelayClock;
};
type WsBridge = {
  id: number;
  cookie: PreviewCookie;
  tcp: LocalTcpStream;
  win: StreamWindow;
  writer: ReturnType<typeof createWriter>;
  ws?: ServerWebSocket<PreviewWsSocketData>;
  buf: Uint8Array;
  unacked: number;
  fragOp: number;
  fragParts: Uint8Array[];
  fragBytes: number;
  closed: boolean;
  revalidating: boolean;
  earlyClose?: { code: number; reason: string };
  cancel: () => void;
  cancelOpenGrace: () => void;
};

const empty = (status: number, extra?: Record<string, string>) =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...extra } });
const prefixOf = (id: string, port: number) => `/api/v1/sandboxes/${id}/ports/${port}`;
const safeWsCode = (c: number) => (c >= 1000 && c <= 4999 && c !== 1005 && c !== 1006 && c !== 1015 ? c : 1000);
function closeStatus(r: RelayCloseReason) {
  if (r === "revoked") return 403;
  if (r === "timeout") return 504;
  if (r === "limit") return 503;
  return 502;
}
function joinU8(a: Uint8Array, b: Uint8Array) {
  if (!a.byteLength) return b;
  if (!b.byteLength) return a;
  const o = new Uint8Array(a.byteLength + b.byteLength);
  o.set(a, 0);
  o.set(b, a.byteLength);
  return o;
}
function findSeq(buf: Uint8Array, seq: Uint8Array) {
  outer: for (let i = 0; i <= buf.byteLength - seq.byteLength; i++) {
    for (let j = 0; j < seq.byteLength; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
function parsePath(pathname: string) {
  const m = PREVIEW_RE.exec(pathname);
  if (!m) return null;
  const port = PORT_RE.test(m[2]!) ? Number(m[2]) : 0;
  if (!UUID_RE.test(m[1]!) || port < 1 || port > 65_535) return { valid: false as const };
  return { valid: true as const, sandboxId: m[1]!.toLowerCase(), port, rest: m[3] || "/" };
}
const isArmadaCookie = (name: string) => /^(?:(?:__host-|__secure-)?(?:armada_|sb-))/i.test(name);
function parseCookies(hdr: string | null) {
  const out: [string, string][] = [];
  for (const part of (hdr ?? "").split(";")) {
    const eq = part.indexOf("=");
    const name = eq > 0 ? part.slice(0, eq).trim() : "";
    if (name) out.push([name, part.slice(eq + 1).trim()]);
  }
  return out;
}
function cleanCookieHdr(hdr: string | null) {
  const kept = parseCookies(hdr)
    .filter(([n]) => !isArmadaCookie(n))
    .map(([n, v]) => `${n}=${v}`);
  return kept.length ? kept.join("; ") : null;
}
function hopSet(vals: string[]) {
  const set = new Set(HOP);
  for (const v of vals) {
    for (const t of v.split(",")) {
      const name = t.trim().toLowerCase();
      if (name) set.add(name);
    }
  }
  return set;
}
function rewriteSetCookie(raw: string, prefix: string) {
  const parts = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const first = parts[0];
  const eq = first?.indexOf("=") ?? -1;
  if (!first || eq <= 0 || isArmadaCookie(first.slice(0, eq).trim())) return null;
  const attrs = parts.slice(1).filter((a) => {
    const idx = a.indexOf("=");
    const name = (idx === -1 ? a : a.slice(0, idx)).trim().toLowerCase();
    return name !== "path" && name !== "domain";
  });
  attrs.push(`Path=${prefix}/`);
  return `${first}; ${attrs.join("; ")}`;
}
function rewriteLocation(raw: string, id: string, port: number) {
  const prefix = prefixOf(id, port);
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw === prefix || raw.startsWith(`${prefix}/`) ? raw : `${prefix}${raw}`;
  }
  if (!/^(?:https?:)?\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw, `http://127.0.0.1:${port}`);
    const defaultPort = u.protocol === "https:" ? 443 : 80;
    const uPort = u.port ? Number(u.port) : defaultPort;
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      LOOPBACK.has(u.hostname.toLowerCase()) &&
      uPort === port
    ) {
      return `${prefix}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {}
  return raw;
}
function parseHead(buf: Uint8Array) {
  const end = findSeq(buf, CRLF2);
  if (end === -1) return buf.byteLength > MAX_HEADER_BYTES ? ("invalid" as const) : ("more" as const);
  if (end > MAX_HEADER_BYTES) return "invalid" as const;
  const lines = Buffer.from(buf.buffer, buf.byteOffset, end).toString("latin1").split("\r\n");
  const sm = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
  const status = sm ? Number(sm[1]) : 0;
  const statusText = sm?.[2] ?? "";
  if (!sm || status < 100 || status > 599 || !REASON_RE.test(statusText)) return "invalid" as const;
  const headers: [string, string][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon <= 0) return "invalid" as const;
    const name = line.slice(0, colon);
    const val = line.slice(colon + 1).trim();
    if (!TOKEN_RE.test(name) || hasBadHeaderChar(val)) return "invalid" as const;
    headers.push([name, val]);
  }
  return { status, statusText, headers, consumed: end + 4 };
}
function createWriter(
  tcp: LocalTcpStream,
  win: StreamWindow,
  onError: (code: number, reason: RelayCloseReason) => void,
  maxQueued = 2 * PREVIEW_WS_MAX_PAYLOAD,
) {
  const q: Uint8Array[] = [];
  let off = 0;
  let queued = 0;
  let closed = false;
  let wakeFn: (() => void) | undefined;
  const wake = () => {
    const fn = wakeFn;
    wakeFn = undefined;
    fn?.();
  };
  const close = () => {
    closed = true;
    q.length = 0;
    queued = 0;
    wake();
  };
  const fail = (code: number, reason: RelayCloseReason) => {
    if (closed) return;
    close();
    onError(code, reason);
  };
  const flush = () => {
    while (!closed && q.length && win.sendAvailable > 0) {
      const head = q[0]!;
      const n = Math.min(win.sendAvailable, MAX_DATA_CHUNK, head.byteLength - off);
      win.consumeSend(n);
      if (!tcp.sendData(off === 0 && n === head.byteLength ? head : head.subarray(off, off + n))) {
        return fail(1012, "eof");
      }
      off += n;
      queued -= n;
      if (off >= head.byteLength) {
        q.shift();
        off = 0;
      }
    }
    if (queued < INITIAL_STREAM_WINDOW) wake();
  };
  return {
    write(b: Uint8Array) {
      if (closed || !b.byteLength) return;
      if (queued + b.byteLength > maxQueued) return fail(1008, "backpressure");
      q.push(b);
      queued += b.byteLength;
      flush();
    },
    waitDrain() {
      if (closed || queued < INITIAL_STREAM_WINDOW) return Promise.resolve();
      return new Promise<void>((r) => {
        wakeFn = r;
      });
    },
    onCredit(n: number) {
      if (closed) return;
      try {
        win.replenishSend(n);
      } catch {
        return fail(1002, "eof");
      }
      flush();
    },
    close,
    get isClosed() {
      return closed;
    },
  };
}
function encodeWsFrame(op: number, payload: Uint8Array) {
  const len = payload.byteLength;
  const mask = randomBytes(4);
  let hdr = 2;
  if (len >= 126 && len <= 0xffff) hdr = 4;
  else if (len > 0xffff) hdr = 10;
  const out = new Uint8Array(hdr + 4 + len);
  out[0] = 0x80 | (op & 0x0f);
  if (hdr === 2) out[1] = 0x80 | len;
  else if (hdr === 4) {
    out[1] = 0x80 | 126;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setUint32(6, len >>> 0, false);
  }
  out.set(mask, hdr);
  for (let i = 0; i < len; i++) out[hdr + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}
function wsCloseBytes(code: number, reason = "") {
  const safe = safeWsCode(code);
  const t = enc.encode(reason).subarray(0, 123);
  const o = new Uint8Array(2 + t.byteLength);
  o[0] = (safe >>> 8) & 0xff;
  o[1] = safe & 0xff;
  o.set(t, 2);
  return o;
}
function parseWsFrame(buf: Uint8Array) {
  if (buf.byteLength < 2) return "more" as const;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  if ((b0 & 0x70) !== 0 || (b1 & 0x80) !== 0) return "invalid" as const;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.byteLength < 4) return "more" as const;
    len = (buf[2]! << 8) | buf[3]!;
    off = 4;
  } else if (len === 127) {
    if (buf.byteLength < 10) return "more" as const;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint32(2, false) > 0 || v.getUint32(6, false) > PREVIEW_WS_MAX_PAYLOAD) return "too_big" as const;
    len = v.getUint32(6, false);
    off = 10;
  }
  if (len > PREVIEW_WS_MAX_PAYLOAD) return "too_big" as const;
  if (opcode >= 0x8 && (!fin || len > 125)) return "invalid" as const;
  if (buf.byteLength < off + len) return "more" as const;
  return { fin, opcode, payload: buf.subarray(off, off + len), consumed: off + len };
}
function resolveBodyMode(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return "none" as const;
  const rawCl = request.headers.get("content-length")?.trim();
  if (rawCl && /^\d+$/.test(rawCl)) {
    const n = Number(rawCl);
    if (Number.isSafeInteger(n)) return n;
  }
  if (request.body === null) return BODY_METHODS.has(request.method) ? 0 : ("none" as const);
  return "chunked" as const;
}
function wsSendSafe(ws: ServerWebSocket<PreviewWsSocketData>, data: string | Uint8Array) {
  try {
    return ws.send(data) !== 0;
  } catch {
    return false;
  }
}

export function createRelayPreview(options: RelayPreviewOptions) {
  const { relayHub, encryptionKey, authenticate } = options;
  const expectedOrigin = new URL(options.publicUrl).origin;
  const clock: RelayClock = options.clock ?? {
    now: () => Date.now(),
    every: (ms, cb) => {
      const t = setInterval(cb, ms);
      return () => clearInterval(t);
    },
    after: (ms, cb) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
  };
  const bridges = new Map<number, WsBridge>();
  const activeStreams = new Set<() => void>();
  let nextBridgeId = 1;
  let stopping = false;

  async function readCookie(request: Request, sandboxId: string, port: number) {
    if (!encryptionKey) return null;
    const now = clock.now();
    for (const [name, raw] of parseCookies(request.headers.get("cookie"))) {
      if (name !== COOKIE_NAME || !raw.startsWith(COOKIE_PREFIX) || raw.length > 8_192) continue;
      const bytes = new Uint8Array(Buffer.from(raw.slice(COOKIE_PREFIX.length), "base64url"));
      const plain = await decryptSecret(bytes, encryptionKey).catch(() => null);
      if (!plain) continue;
      let json: unknown;
      try {
        json = JSON.parse(plain);
      } catch {
        continue;
      }
      const parsed = cookieSchema.safeParse(json);
      if (!parsed.success) continue;
      const c = parsed.data;
      if (c.sandboxId === sandboxId && c.port === port && c.exp > now && c.exp <= now + PREVIEW_TTL_MS) return c;
    }
    return null;
  }

  async function handleEnter(request: Request) {
    if (stopping) return empty(503);
    if (request.method !== "POST") return empty(405, { allow: "POST" });
    if (new URL(request.url).search) return empty(400);
    if (!encryptionKey) return empty(503);
    const media = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/x-www-form-urlencoded" && media !== "application/json") return empty(415);
    let text: string;
    try {
      text = await readBoundedText(request, MAX_ENTER_BYTES);
    } catch (e) {
      return empty(e instanceof BodyTooLargeError ? 413 : 400);
    }
    let ticket: string | null = null;
    if (media === "application/x-www-form-urlencoded") {
      ticket = new URLSearchParams(text).get("ticket");
    } else {
      try {
        const o = JSON.parse(text) as unknown;
        if (
          o &&
          typeof o === "object" &&
          !Array.isArray(o) &&
          typeof (o as Record<string, unknown>).ticket === "string"
        ) {
          ticket = (o as Record<string, unknown>).ticket as string;
        }
      } catch {
        return empty(400);
      }
    }
    if (!ticket) return empty(400);
    const claims = await relayHub.redeemTicket(ticket);
    if (!claims) return empty(401);
    if (claims.mode !== "preview" || claims.port === undefined) return empty(403);
    const access = await relayHub.checkAccess(claims.orgIds, claims.userId, claims.sandboxId);
    if (!access.ok) return empty(access.status);
    if (!access.epoch || access.epoch !== claims.epoch || !relayHub.isConnected(claims.sandboxId, claims.epoch)) {
      return empty(503);
    }
    const cookie: PreviewCookie = {
      purpose: "sandbox-preview-v1",
      sandboxId: claims.sandboxId,
      port: claims.port,
      epoch: claims.epoch,
      userId: claims.userId,
      orgIds: claims.orgIds,
      exp: clock.now() + PREVIEW_TTL_MS,
    };
    const sealed =
      COOKIE_PREFIX + Buffer.from(await encryptSecret(JSON.stringify(cookie), encryptionKey)).toString("base64url");
    const path = `${prefixOf(claims.sandboxId, claims.port)}/`;
    return new Response(null, {
      status: 303,
      headers: {
        location: path,
        "set-cookie": `${COOKIE_NAME}=${sealed}; HttpOnly; Secure; SameSite=Lax; Max-Age=${PREVIEW_TTL_MS / 1000}; Path=${path}`,
        "cache-control": "no-store",
      },
    });
  }

  async function authorizeHttp(request: Request, sandboxId: string, port: number) {
    const cookie = await readCookie(request, sandboxId, port);
    if (cookie) {
      const a = await relayHub.checkAccess(cookie.orgIds, cookie.userId, sandboxId);
      if (!a.ok) return { ok: false as const, response: empty(a.status) };
      if (!a.epoch || a.epoch !== cookie.epoch || !relayHub.isConnected(sandboxId, a.epoch)) {
        return { ok: false as const, response: empty(503) };
      }
      return { ok: true as const, epoch: a.epoch };
    }
    if (!request.headers.get("authorization") || !authenticate) return { ok: false as const, response: empty(401) };
    let auth: CallerResult;
    try {
      auth = await authenticate(request);
    } catch (e) {
      return { ok: false as const, response: empty(e instanceof AuthUnavailable ? 503 : 401) };
    }
    if (!auth.ok) return { ok: false as const, response: empty(401) };
    const a = await relayHub.checkAccess(
      auth.caller.orgs.map((o) => o.orgId),
      auth.caller.userId,
      sandboxId,
    );
    if (!a.ok) return { ok: false as const, response: empty(a.status) };
    if (!a.epoch || !relayHub.isConnected(sandboxId, a.epoch)) return { ok: false as const, response: empty(503) };
    return { ok: true as const, epoch: a.epoch };
  }

  async function handleHttpProxy(
    request: Request,
    sandboxId: string,
    port: number,
    rest: string,
    configureRequestTimeout?: (request: Request, seconds: number) => void,
  ) {
    if (stopping) return empty(503);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return empty(426, { upgrade: "websocket" });
    const upstreamPath = `${rest}${new URL(request.url).search}`;
    if (!TOKEN_RE.test(request.method) || /[\r\n]/.test(upstreamPath)) return empty(400);
    const auth = await authorizeHttp(request, sandboxId, port);
    if (!auth.ok) return auth.response;
    configureRequestTimeout?.(request, 0);

    const bodyMode = resolveBodyMode(request);
    const win = new StreamWindow(INITIAL_STREAM_WINDOW, CREDIT_WATERMARK);
    const headDone = Promise.withResolvers<Response>();
    const pendingOut: { data: Uint8Array; ack: number }[] = [];
    let opened = false;
    let headResolved = false;
    let cleaned = false;
    let upstreamEnded = false;
    let bodyModeRes: "chunked" | "length" | "eof" = "eof";
    let bodyRem = 0;
    let chunkState: "size" | "data" | "crlf" | "trailers" | "done" = "size";
    let headerBuf: Uint8Array = EMPTY_U8;
    let chunkBuf: Uint8Array = EMPTY_U8;
    let upstreamError: Error | undefined;
    let bodyCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let tcp!: LocalTcpStream;
    let writer!: ReturnType<typeof createWriter>;

    const ackBytes = (n: number) => {
      if (n <= 0) return;
      const g = win.acknowledgeReceived(n);
      if (g > 0) tcp.sendCredit(g);
    };
    const cleanup = (code = 1000, reason: RelayCloseReason = "eof") => {
      if (cleaned) return;
      cleaned = true;
      cancelTimeout();
      request.signal.removeEventListener("abort", onAbort);
      activeStreams.delete(onStop);
      writer?.close();
      tcp?.close(code, reason);
    };
    const failOrError = (status: number, msg: string, code: number, reason: RelayCloseReason = "eof") => {
      if (!headResolved) {
        headResolved = true;
        headDone.resolve(empty(status));
      } else {
        try {
          bodyCtrl?.error(new Error(msg));
        } catch {}
      }
      cleanup(code, reason);
    };
    const onAbort = () => failOrError(499, "Aborted.", 1000);
    const onStop = () => failOrError(503, "Stopping.", 1012);
    const cancelTimeout = clock.after(TIMEOUT_MS, () => {
      if (!headResolved) failOrError(504, "Timeout.", 1001, "timeout");
    });
    const flushBody = () => {
      if (!bodyCtrl) return;
      while (pendingOut.length && (bodyCtrl.desiredSize ?? 1) > 0) {
        const item = pendingOut.shift()!;
        if (item.data.byteLength) bodyCtrl.enqueue(item.data);
        ackBytes(item.ack);
      }
      if (!pendingOut.length && upstreamError) {
        const err = upstreamError;
        upstreamError = undefined;
        try {
          bodyCtrl.error(err);
        } catch {}
        cleanup(1002);
      } else if (!pendingOut.length && upstreamEnded) {
        try {
          bodyCtrl.close();
        } catch {}
        cleanup(1000);
      }
    };
    const feedBody = (raw: Uint8Array) => {
      if (bodyModeRes === "eof") {
        if (raw.byteLength) pendingOut.push({ data: raw, ack: raw.byteLength });
        return flushBody();
      }
      if (bodyModeRes === "length") {
        const take = Math.min(raw.byteLength, bodyRem);
        bodyRem -= take;
        if (take > 0) pendingOut.push({ data: raw.subarray(0, take), ack: raw.byteLength });
        else ackBytes(raw.byteLength);
        if (bodyRem === 0) upstreamEnded = true;
        return flushBody();
      }
      chunkBuf = joinU8(chunkBuf, raw);
      let consumed = 0;
      while (chunkState !== "done" && !upstreamError) {
        if (chunkState === "size") {
          const idx = findSeq(chunkBuf, CRLF);
          if (idx === -1) break;
          const hex = dec.decode(chunkBuf.subarray(0, idx)).split(";")[0]!.trim();
          if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) {
            upstreamError = new Error("Invalid chunk size.");
            break;
          }
          const size = Number.parseInt(hex, 16);
          chunkBuf = chunkBuf.subarray(idx + 2);
          consumed += idx + 2;
          if (size === 0) chunkState = "trailers";
          else {
            bodyRem = size;
            chunkState = "data";
          }
        } else if (chunkState === "data") {
          if (!chunkBuf.byteLength) break;
          const take = Math.min(chunkBuf.byteLength, bodyRem);
          pendingOut.push({ data: chunkBuf.subarray(0, take), ack: take + consumed });
          chunkBuf = chunkBuf.subarray(take);
          bodyRem -= take;
          consumed = 0;
          if (bodyRem === 0) chunkState = "crlf";
        } else if (chunkState === "crlf") {
          if (chunkBuf.byteLength < 2) break;
          if (chunkBuf[0] !== 13 || chunkBuf[1] !== 10) {
            upstreamError = new Error("Invalid chunk terminator.");
            break;
          }
          chunkBuf = chunkBuf.subarray(2);
          consumed += 2;
          chunkState = "size";
        } else {
          const isEmptyTrailer = chunkBuf.byteLength >= 2 && chunkBuf[0] === 13 && chunkBuf[1] === 10;
          const idx = isEmptyTrailer ? 0 : findSeq(chunkBuf, CRLF2);
          if (idx === -1) break;
          consumed += chunkBuf.byteLength;
          chunkBuf = EMPTY_U8;
          chunkState = "done";
          upstreamEnded = true;
        }
      }
      if (consumed > 0) pendingOut.push({ data: EMPTY_U8, ack: consumed });
      flushBody();
    };
    const sendRequest = async () => {
      const hop = hopSet(request.headers.get("connection") ? [request.headers.get("connection")!] : []);
      const lines = [`${request.method} ${upstreamPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
      request.headers.forEach((v, k) => {
        const l = k.toLowerCase();
        if (
          !hop.has(l) &&
          l !== "host" &&
          l !== "authorization" &&
          l !== "cookie" &&
          l !== "content-length" &&
          !/[\r\n]/.test(k) &&
          !/[\r\n]/.test(v)
        ) {
          lines.push(`${k}: ${v}`);
        }
      });
      const ck = cleanCookieHdr(request.headers.get("cookie"));
      if (ck) lines.push(`Cookie: ${ck}`);
      if (bodyMode === "chunked") lines.push("Transfer-Encoding: chunked");
      else if (typeof bodyMode === "number") lines.push(`Content-Length: ${bodyMode}`);
      writer.write(enc.encode(`${lines.join("\r\n")}\r\n\r\n`));
      if (bodyMode === "none" || bodyMode === 0) return;
      if (!request.body) return failOrError(400, "Missing request body.", 1001);
      const reader = request.body.getReader();
      let sent = 0;
      try {
        while (!writer.isClosed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          if (bodyMode === "chunked") {
            for (let off = 0; off < value.byteLength && !writer.isClosed; off += INITIAL_STREAM_WINDOW) {
              const part = value.subarray(off, Math.min(value.byteLength, off + INITIAL_STREAM_WINDOW));
              writer.write(enc.encode(`${part.byteLength.toString(16)}\r\n`));
              writer.write(part);
              writer.write(CRLF);
              await writer.waitDrain();
            }
          } else {
            const take = Math.min(value.byteLength, bodyMode - sent);
            for (let off = 0; off < take && !writer.isClosed; off += INITIAL_STREAM_WINDOW) {
              const part = value.subarray(off, Math.min(take, off + INITIAL_STREAM_WINDOW));
              writer.write(part);
              sent += part.byteLength;
              await writer.waitDrain();
            }
          }
        }
        if (writer.isClosed) return;
        if (bodyMode === "chunked") writer.write(enc.encode("0\r\n\r\n"));
        else if (sent < bodyMode) failOrError(400, "Truncated request body.", 1001);
      } catch (err) {
        const status = err instanceof BodyTooLargeError ? 413 : 400;
        failOrError(status, "Request body read failed.", 1001);
      } finally {
        reader.releaseLock();
      }
    };

    const openedTcp = relayHub.openTcp(
      sandboxId,
      port,
      {
        onOpen() {
          if (opened) return failOrError(502, "Duplicate OPEN_OK.", 1002);
          opened = true;
          void sendRequest();
        },
        onCredit: (n) => writer.onCredit(n),
        onData(data) {
          if (!opened) return failOrError(502, "Unexpected data before open.", 1002);
          if (!win.recordReceived(data.byteLength)) {
            if (!headResolved) return failOrError(502, "Backpressure.", 1008, "backpressure");
            upstreamError = new Error("Backpressure.");
            return flushBody();
          }
          if (headResolved) return feedBody(data);
          headerBuf = joinU8(headerBuf, data);
          while (!headResolved) {
            const parsed = parseHead(headerBuf);
            if (parsed === "more") return;
            if (parsed === "invalid") return failOrError(502, "Bad headers.", 1002);
            headerBuf = headerBuf.subarray(parsed.consumed);
            ackBytes(parsed.consumed);
            if (parsed.status >= 100 && parsed.status < 200) {
              if (parsed.status === 101) return failOrError(502, "Unexpected 101.", 1002);
              continue;
            }
            const byName = (name: string) => parsed.headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
            const hop = hopSet(byName("connection"));
            const te = byName("transfer-encoding")
              .flatMap((v) => v.split(","))
              .map((v) => v.trim().toLowerCase())
              .filter(Boolean);
            const cl = byName("content-length");
            if (te.length && (te.length > 1 || te[0] !== "chunked")) return failOrError(502, "Unsupported TE.", 1002);
            const isChunked = te[0] === "chunked";
            let contentLength: number | null = null;
            if (!isChunked && cl.length) {
              const first = cl[0]!.trim();
              if (!/^\d+$/.test(first) || cl.some((v) => v.trim() !== first)) {
                return failOrError(502, "Bad CL.", 1002);
              }
              contentLength = Number(first);
            }
            let outHeaders: Headers;
            try {
              outHeaders = new Headers();
              const prefix = prefixOf(sandboxId, port);
              for (const [k, v] of parsed.headers) {
                const l = k.toLowerCase();
                if (hop.has(l) || (l === "content-length" && isChunked)) continue;
                if (l === "content-length") outHeaders.set("content-length", String(contentLength));
                else if (l === "set-cookie") {
                  const rw = rewriteSetCookie(v, prefix);
                  if (rw) outHeaders.append("set-cookie", rw);
                } else if (l === "location") outHeaders.set("location", rewriteLocation(v, sandboxId, port));
                else outHeaders.append(k, v);
              }
              outHeaders.set("x-content-type-options", "nosniff");
            } catch {
              return failOrError(502, "Invalid upstream header.", 1002);
            }
            if (request.method === "HEAD" || NULL_BODY.has(parsed.status) || contentLength === 0) {
              let response: Response;
              try {
                response = new Response(null, {
                  status: parsed.status,
                  statusText: parsed.statusText,
                  headers: outHeaders,
                });
              } catch {
                return failOrError(502, "Invalid upstream status.", 1002);
              }
              ackBytes(headerBuf.byteLength);
              headerBuf = EMPTY_U8;
              headResolved = true;
              cleanup(1000);
              return headDone.resolve(response);
            }
            if (isChunked) bodyModeRes = "chunked";
            else if (contentLength !== null) bodyModeRes = "length";
            else bodyModeRes = "eof";
            bodyRem = contentLength ?? 0;
            const initial = headerBuf;
            headerBuf = EMPTY_U8;
            let response: Response;
            try {
              const stream = new ReadableStream<Uint8Array>({
                start(c) {
                  bodyCtrl = c;
                  if (initial.byteLength) feedBody(initial);
                  else flushBody();
                },
                pull: flushBody,
                cancel: () => cleanup(1000),
              });
              response = new Response(stream, {
                status: parsed.status,
                statusText: parsed.statusText,
                headers: outHeaders,
              });
            } catch {
              return failOrError(502, "Invalid upstream response.", 1002);
            }
            cancelTimeout();
            headResolved = true;
            headDone.resolve(response);
          }
        },
        onClose(_code, reason) {
          if (!headResolved) return failOrError(opened ? 502 : closeStatus(reason), "Closed.", 1000, reason);
          if (bodyModeRes === "eof" || (bodyModeRes === "length" && bodyRem === 0) || chunkState === "done") {
            upstreamEnded = true;
          } else upstreamError = new Error("Premature close.");
          flushBody();
        },
      },
      auth.epoch,
    );
    if (!openedTcp.ok) {
      cancelTimeout();
      return empty(503);
    }
    tcp = openedTcp.stream;
    writer = createWriter(tcp, win, (code, reason) => failOrError(502, "Relay write error.", code, reason));
    activeStreams.add(onStop);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    return headDone.promise;
  }

  function closeBridge(b: WsBridge, code: number, reason = "", notifyTcp: RelayCloseReason | null = "eof") {
    if (b.closed) return;
    b.closed = true;
    b.cancel();
    b.cancelOpenGrace();
    b.writer.close();
    if (notifyTcp) b.tcp.close(code, notifyTcp);
    if (b.ws) {
      bridges.delete(b.id);
      try {
        b.ws.close(code, reason);
      } catch {}
    } else b.earlyClose = { code, reason };
  }

  function ackWsPending(b: WsBridge) {
    if (b.closed || !b.ws || b.unacked <= 0) return;
    const grant = b.win.acknowledgeReceived(b.unacked);
    b.unacked = 0;
    if (grant > 0) b.tcp.sendCredit(grant);
  }

  function drainWs(b: WsBridge) {
    while (!b.closed && b.ws) {
      const f = parseWsFrame(b.buf);
      if (f === "more") {
        if (b.buf.byteLength + b.fragBytes > PREVIEW_WS_MAX_PAYLOAD + 16)
          return closeBridge(b, 1009, "Too big", "backpressure");
        ackWsPending(b);
        return;
      }
      if (f === "too_big") return closeBridge(b, 1009, "Message too big");
      if (f === "invalid") return closeBridge(b, 1002, "Protocol error");
      b.buf = b.buf.subarray(f.consumed);
      if (f.opcode === 0x9) {
        b.writer.write(encodeWsFrame(0xa, f.payload));
        continue;
      }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x8) {
        const code = safeWsCode(f.payload.byteLength >= 2 ? (f.payload[0]! << 8) | f.payload[1]! : 1000);
        const reason = f.payload.byteLength > 2 ? dec.decode(f.payload.subarray(2)) : "";
        b.writer.write(encodeWsFrame(0x8, wsCloseBytes(code, reason)));
        return closeBridge(b, code, reason);
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (b.fragOp !== 0) return closeBridge(b, 1002);
        if (f.fin) {
          if (!wsSendSafe(b.ws, f.opcode === 0x1 ? dec.decode(f.payload) : new Uint8Array(f.payload))) {
            return closeBridge(b, 1012);
          }
        } else {
          b.fragOp = f.opcode;
          b.fragParts = [new Uint8Array(f.payload)];
          b.fragBytes = f.payload.byteLength;
        }
        continue;
      }
      if (f.opcode === 0x0) {
        if (b.fragOp === 0) return closeBridge(b, 1002);
        b.fragBytes += f.payload.byteLength;
        if (b.fragBytes > PREVIEW_WS_MAX_PAYLOAD) return closeBridge(b, 1009);
        b.fragParts.push(new Uint8Array(f.payload));
        if (f.fin) {
          const full = new Uint8Array(b.fragBytes);
          let off = 0;
          for (const p of b.fragParts) {
            full.set(p, off);
            off += p.byteLength;
          }
          const op = b.fragOp;
          b.fragOp = 0;
          b.fragParts = [];
          b.fragBytes = 0;
          if (!wsSendSafe(b.ws, op === 0x1 ? dec.decode(full) : full)) return closeBridge(b, 1012);
        }
        continue;
      }
      return closeBridge(b, 1002);
    }
    ackWsPending(b);
  }

  async function revalidateBridge(b: WsBridge) {
    if (b.closed || stopping || b.revalidating) return;
    if (b.cookie.exp <= clock.now()) return closeBridge(b, 4401, "", "revoked");
    b.revalidating = true;
    try {
      const a = await relayHub.checkAccess(b.cookie.orgIds, b.cookie.userId, b.cookie.sandboxId);
      if (b.closed || stopping) return;
      if (!a.ok) return closeBridge(b, a.code === "forbidden" ? 4403 : 4401, "", "revoked");
      if (a.epoch !== b.cookie.epoch || !relayHub.isConnected(b.cookie.sandboxId, b.cookie.epoch)) {
        return closeBridge(b, 1012, "", null);
      }
      try {
        b.ws?.ping?.();
      } catch {}
    } catch {
      closeBridge(b, 1012, "", "revoked");
    } finally {
      b.revalidating = false;
    }
  }

  async function upgradeWebSocket(
    request: Request,
    accept: (data: PreviewWsSocketData, headers?: Record<string, string>) => boolean,
  ) {
    if (stopping) return empty(503);
    if (request.method !== "GET") return empty(405, { allow: "GET" });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return empty(426, { upgrade: "websocket" });
    const url = new URL(request.url);
    const parsed = parsePath(url.pathname);
    if (!parsed || !parsed.valid) return empty(400);
    if (request.headers.get("origin") !== expectedOrigin) return empty(403);
    const cookie = await readCookie(request, parsed.sandboxId, parsed.port);
    if (!cookie) return empty(401);
    const access = await relayHub.checkAccess(cookie.orgIds, cookie.userId, parsed.sandboxId);
    if (!access.ok) return empty(access.status);
    if (!access.epoch || access.epoch !== cookie.epoch || !relayHub.isConnected(parsed.sandboxId, access.epoch)) {
      return empty(503);
    }
    const upstreamPath = `${parsed.rest}${url.search}`;
    if (/[\r\n]/.test(upstreamPath)) return empty(400);
    const reqProto = request.headers.get("sec-websocket-protocol");
    const reqProtos = (reqProto ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const wsKey = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(wsKey + WS_GUID)
      .digest("base64");
    const win = new StreamWindow(INITIAL_STREAM_WINDOW, CREDIT_WATERMARK);
    const handshake = Promise.withResolvers<
      { ok: true; proto?: string; bridge: WsBridge } | { ok: false; status: number }
    >();
    let hsDone = false;
    let opened = false;
    let hsBuf: Uint8Array = EMPTY_U8;
    let bridge: WsBridge | undefined;
    let tcp!: LocalTcpStream;
    let writer!: ReturnType<typeof createWriter>;
    const finishHs = (v: { ok: true; proto?: string; bridge: WsBridge } | { ok: false; status: number }) => {
      if (hsDone) return;
      hsDone = true;
      cancelHs();
      activeStreams.delete(onHsStop);
      request.signal.removeEventListener("abort", onHsAbort);
      handshake.resolve(v);
    };
    const onHsAbort = () => {
      tcp?.close(1000, "eof");
      finishHs({ ok: false, status: 499 });
    };
    const onHsStop = () => {
      tcp?.close(1012, "eof");
      finishHs({ ok: false, status: 503 });
    };
    const cancelHs = clock.after(TIMEOUT_MS, () => {
      tcp?.close(1001, "timeout");
      finishHs({ ok: false, status: 504 });
    });

    const openedTcp = relayHub.openTcp(
      parsed.sandboxId,
      parsed.port,
      {
        onOpen() {
          if (opened) {
            if (!hsDone) {
              tcp.close(1002, "eof");
              return finishHs({ ok: false, status: 502 });
            }
            if (bridge) closeBridge(bridge, 1002, "Protocol error", "eof");
            return;
          }
          opened = true;
          const lines = [
            `GET ${upstreamPath} HTTP/1.1`,
            `Host: 127.0.0.1:${parsed.port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${wsKey}`,
            "Sec-WebSocket-Version: 13",
            `Origin: http://127.0.0.1:${parsed.port}`,
          ];
          if (reqProtos.length && !/[\r\n]/.test(reqProto!)) lines.push(`Sec-WebSocket-Protocol: ${reqProto}`);
          const ck = cleanCookieHdr(request.headers.get("cookie"));
          if (ck) lines.push(`Cookie: ${ck}`);
          writer.write(enc.encode(`${lines.join("\r\n")}\r\n\r\n`));
        },
        onCredit: (n) => writer.onCredit(n),
        onData(data) {
          if (!opened) {
            tcp.close(1002, "eof");
            return finishHs({ ok: false, status: 502 });
          }
          if (!win.recordReceived(data.byteLength)) {
            if (!hsDone) {
              tcp.close(1008, "backpressure");
              return finishHs({ ok: false, status: 502 });
            }
            if (bridge) closeBridge(bridge, 1008, "", "backpressure");
            return;
          }
          if (!hsDone) {
            hsBuf = joinU8(hsBuf, data);
            const res = parseHead(hsBuf);
            if (res === "more") return;
            if (res === "invalid" || res.status !== 101) {
              tcp.close(1002, "eof");
              return finishHs({ ok: false, status: 502 });
            }
            const hdrs = new Map(res.headers.map(([k, v]) => [k.toLowerCase(), v]));
            const chosen = hdrs.get("sec-websocket-protocol")?.trim();
            if (
              hdrs.get("upgrade")?.toLowerCase() !== "websocket" ||
              hdrs.get("sec-websocket-accept") !== expectedAccept ||
              (chosen && (!reqProtos.includes(chosen) || /[\r\n]/.test(chosen)))
            ) {
              tcp.close(1002, "eof");
              return finishHs({ ok: false, status: 502 });
            }
            const leftover = hsBuf.subarray(res.consumed);
            const grant = win.acknowledgeReceived(res.consumed);
            if (grant > 0) tcp.sendCredit(grant);
            hsBuf = EMPTY_U8;
            const id = nextBridgeId++;
            bridge = {
              id,
              cookie,
              tcp,
              win,
              writer,
              buf: leftover,
              unacked: leftover.byteLength,
              fragOp: 0,
              fragParts: [],
              fragBytes: 0,
              closed: false,
              revalidating: false,
              cancel: () => {},
              cancelOpenGrace: () => {},
            };
            bridges.set(id, bridge);
            return finishHs({ ok: true, ...(chosen ? { proto: chosen } : {}), bridge });
          }
          if (bridge) {
            bridge.buf = joinU8(bridge.buf, data);
            bridge.unacked += data.byteLength;
            drainWs(bridge);
          }
        },
        onClose(code, reason) {
          if (!hsDone) return finishHs({ ok: false, status: opened ? 502 : closeStatus(reason) });
          if (bridge) closeBridge(bridge, reason === "revoked" ? code : 1012, "", null);
        },
      },
      access.epoch,
    );
    if (!openedTcp.ok) {
      cancelHs();
      return empty(503);
    }
    tcp = openedTcp.stream;
    writer = createWriter(tcp, win, (code, reason) => {
      if (!hsDone) {
        tcp.close(code, reason);
        return finishHs({ ok: false, status: 502 });
      }
      if (bridge) closeBridge(bridge, code, "", reason);
    });
    activeStreams.add(onHsStop);
    if (request.signal.aborted) onHsAbort();
    else request.signal.addEventListener("abort", onHsAbort, { once: true });
    const result = await handshake.promise;
    if (!result.ok) return empty(result.status);
    const live = result.bridge;
    if (stopping || request.signal.aborted) {
      closeBridge(live, stopping ? 1012 : 1000, "", "eof");
      bridges.delete(live.id);
      return empty(stopping ? 503 : 499);
    }
    if (live.closed) {
      bridges.delete(live.id);
      return empty(502);
    }
    if (
      !accept(
        { kind: "preview-ws", id: live.id },
        result.proto ? { "sec-websocket-protocol": result.proto } : undefined,
      )
    ) {
      closeBridge(live, 1000, "", "eof");
      bridges.delete(live.id);
      return empty(400);
    }
    if (!live.closed) {
      live.cancel = clock.every(TIMEOUT_MS, () => void revalidateBridge(live));
      live.cancelOpenGrace = clock.after(WS_OPEN_GRACE_MS, () => {
        if (!live.ws) {
          closeBridge(live, 1001, "", "eof");
          bridges.delete(live.id);
        }
      });
    }
    return undefined;
  }

  const websocket: WebSocketHandler<PreviewWsSocketData> = {
    open(socket) {
      const b = bridges.get(socket.data.id);
      if (!b || b.closed || stopping) {
        bridges.delete(socket.data.id);
        try {
          socket.close(b?.earlyClose?.code ?? 1012, b?.earlyClose?.reason ?? "");
        } catch {}
        return;
      }
      b.cancelOpenGrace();
      b.ws = socket;
      if (b.buf.byteLength || b.unacked > 0) drainWs(b);
    },
    message(socket, m) {
      const b = bridges.get(socket.data.id);
      if (!b || b.closed || stopping) return;
      const bytes = typeof m === "string" ? enc.encode(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
      b.writer.write(encodeWsFrame(typeof m === "string" ? 0x1 : 0x2, bytes));
    },
    close(socket, code, reason) {
      const b = bridges.get(socket.data.id);
      if (!b || b.closed) return;
      b.writer.write(encodeWsFrame(0x8, wsCloseBytes(code, reason)));
      closeBridge(b, code, reason, "eof");
    },
  };

  async function route(request: Request, configureRequestTimeout?: (request: Request, seconds: number) => void) {
    const pathname = new URL(request.url).pathname;
    if (pathname === ENTER_PATH) return handleEnter(request);
    const parsed = parsePath(pathname);
    if (!parsed) return null;
    if (!parsed.valid) return empty(400);
    return handleHttpProxy(request, parsed.sandboxId, parsed.port, parsed.rest, configureRequestTimeout);
  }

  async function stop() {
    stopping = true;
    for (const fn of [...activeStreams]) fn();
    for (const b of [...bridges.values()]) {
      closeBridge(b, 1012, "", "eof");
      bridges.delete(b.id);
    }
  }

  return { route, upgradeWebSocket, websocket, isPreviewPath: (pathname: string) => PREVIEW_RE.test(pathname), stop };
}
export type RelayPreview = ReturnType<typeof createRelayPreview>;
