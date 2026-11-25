export const RELAY_PROTOCOL_VERSION = 1 as const;
export const MAX_RELAY_FRAME = 65_536 as const;
export const MAX_DATA_CHUNK = 32_768 as const;
export const INITIAL_STREAM_WINDOW = 262_144 as const;
export const CREDIT_WATERMARK = 65_536 as const;
export const MAX_PTYS_PER_SANDBOX = 4 as const;
export const MAX_TCP_PER_SANDBOX = 16 as const;
export const MAX_STREAMS_PER_SANDBOX = 20 as const;

export const RELAY_OPCODE = {
  OPEN_PTY: 0x01,
  OPEN_TCP: 0x02,
  OPEN_OK: 0x03,
  DATA: 0x04,
  CREDIT: 0x05,
  RESIZE: 0x06,
  CLOSE: 0x07,
  PING: 0x08,
  PONG: 0x09,
} as const;
export type RelayOpcode = (typeof RELAY_OPCODE)[keyof typeof RELAY_OPCODE];
export const RELAY_CLOSE_REASONS = ["eof", "refused", "limit", "revoked", "timeout", "backpressure"] as const;
export type RelayCloseReason = (typeof RELAY_CLOSE_REASONS)[number];
export type RelayProtocolErrorCode =
  | "truncated_frame"
  | "oversized_frame"
  | "unsupported_version"
  | "unknown_opcode"
  | "invalid_stream_id"
  | "invalid_payload"
  | "invalid_port"
  | "invalid_terminal_size"
  | "invalid_close_reason";

export class RelayProtocolError extends Error {
  readonly code: RelayProtocolErrorCode;
  constructor(code: RelayProtocolErrorCode, message: string) {
    super(message);
    this.name = "RelayProtocolError";
    this.code = code;
  }
}
export type RelayFrame = { version: 1; type: RelayOpcode; streamId: number; payload: Uint8Array };
export type RelayMessage =
  | { type: typeof RELAY_OPCODE.OPEN_PTY; streamId: number; cols: number; rows: number; cwd?: string }
  | { type: typeof RELAY_OPCODE.OPEN_TCP; streamId: number; port: number }
  | { type: typeof RELAY_OPCODE.OPEN_OK; streamId: number }
  | { type: typeof RELAY_OPCODE.DATA; streamId: number; data: Uint8Array }
  | { type: typeof RELAY_OPCODE.CREDIT; streamId: number; bytes: number }
  | { type: typeof RELAY_OPCODE.RESIZE; streamId: number; cols: number; rows: number }
  | { type: typeof RELAY_OPCODE.CLOSE; streamId: number; code: number; reason: RelayCloseReason }
  | { type: typeof RELAY_OPCODE.PING | typeof RELAY_OPCODE.PONG; streamId?: 0; nonce?: Uint8Array };
const { OPEN_PTY, OPEN_TCP, OPEN_OK, DATA, CREDIT, RESIZE, CLOSE, PING, PONG } = RELAY_OPCODE;
const HEADER = 10;
const MAX_PAYLOAD = MAX_RELAY_FRAME - HEADER;
const U32 = 0xffff_ffff;
const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const closeReasons = new Set<string>(RELAY_CLOSE_REASONS);
const ptyKeys = new Set(["cols", "rows", "cwd"]);
function fail(code: RelayProtocolErrorCode, msg: string): never {
  throw new RelayProtocolError(code, msg);
}
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const intIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const isOpcode = (v: number): v is RelayOpcode => intIn(v, OPEN_PTY, PONG);
const isReason = (v: string): v is RelayCloseReason => closeReasons.has(v);
const be = (size: number, write: (v: DataView) => void) => {
  const o = new Uint8Array(size);
  write(viewOf(o));
  return o;
};
const checkStream = (id: number, type: RelayOpcode) => {
  const ctrl = type === PING || type === PONG;
  if (!intIn(id, 0, U32) || (ctrl ? id !== 0 : type !== CLOSE && id === 0)) fail("invalid_stream_id", "Bad stream.");
  return id;
};
const checkCwd = (cwd: unknown) =>
  cwd === undefined
    ? undefined
    : typeof cwd === "string" && cwd.length >= 1 && cwd.length <= 4096 && !cwd.includes("\0")
      ? cwd
      : fail("invalid_payload", "Invalid cwd.");
const utf8 = (b: Uint8Array) => {
  try {
    return dec.decode(b);
  } catch {
    fail("invalid_payload", "Invalid UTF-8.");
  }
};
const parseJson = (b: Uint8Array) => {
  const text = utf8(b);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("invalid_payload", "Bad JSON.");
  }
};
export const validateRelayPort = (port: number) => (intIn(port, 1, 0xffff) ? port : fail("invalid_port", "Bad port."));
export const validateTerminalSize = (cols: number, rows: number) =>
  intIn(cols, 1, 500) && intIn(rows, 1, 200) ? { cols, rows } : fail("invalid_terminal_size", "Bad terminal size.");
export const clampTerminalSize = (cols: number, rows: number) =>
  typeof cols === "number" && Number.isFinite(cols) && typeof rows === "number" && Number.isFinite(rows)
    ? { cols: Math.min(500, Math.max(1, Math.trunc(cols))), rows: Math.min(200, Math.max(1, Math.trunc(rows))) }
    : fail("invalid_terminal_size", "Non-finite terminal size.");

export function encodeRelayFrame(type: RelayOpcode, streamId: number, payload: Uint8Array = EMPTY) {
  if (!isOpcode(type)) fail("unknown_opcode", "Unknown opcode.");
  if (!intIn(streamId, 0, U32)) fail("invalid_stream_id", "Bad stream id.");
  if (payload.byteLength > MAX_PAYLOAD) fail("oversized_frame", "Payload exceeds limit.");
  const frame = be(HEADER + payload.byteLength, (v) => {
    v.setUint8(0, RELAY_PROTOCOL_VERSION);
    v.setUint8(1, type);
    v.setUint32(2, streamId, false);
    v.setUint32(6, payload.byteLength, false);
  });
  frame.set(payload, HEADER);
  return frame;
}
export function decodeRelayFrame(bytes: Uint8Array) {
  if (bytes.byteLength < HEADER) fail("truncated_frame", "Short header.");
  if (bytes.byteLength > MAX_RELAY_FRAME) fail("oversized_frame", "Frame too large.");
  const v = viewOf(bytes);
  if (v.getUint8(0) !== RELAY_PROTOCOL_VERSION) fail("unsupported_version", "Bad version.");
  const type = v.getUint8(1);
  if (!isOpcode(type)) fail("unknown_opcode", "Unknown opcode.");
  const len = v.getUint32(6, false);
  if (len > MAX_PAYLOAD) fail("oversized_frame", "Payload too large.");
  const end = HEADER + len;
  if (bytes.byteLength !== end) fail(bytes.byteLength < end ? "truncated_frame" : "invalid_payload", "Bad length.");
  return {
    version: 1,
    type,
    streamId: v.getUint32(2, false),
    payload: bytes.subarray(HEADER, end),
  } satisfies RelayFrame;
}
export function encodeRelayMessage(m: RelayMessage) {
  const send = (p: Uint8Array) => encodeRelayFrame(m.type, checkStream(m.streamId ?? 0, m.type), p);
  if (m.type === OPEN_PTY) {
    const s = clampTerminalSize(m.cols, m.rows);
    const cwd = checkCwd(m.cwd);
    return send(enc.encode(JSON.stringify(cwd === undefined ? s : { ...s, cwd })));
  }
  if (m.type === OPEN_TCP) return send(be(2, (v) => v.setUint16(0, validateRelayPort(m.port), false)));
  if (m.type === OPEN_OK) return send(EMPTY);
  if (m.type === DATA) return m.data.byteLength <= MAX_DATA_CHUNK ? send(m.data) : fail("oversized_frame", "Large.");
  if (m.type === CREDIT) {
    if (!intIn(m.bytes, 1, U32)) fail("invalid_payload", "Bad credit.");
    return send(be(4, (v) => v.setUint32(0, m.bytes, false)));
  }
  if (m.type === RESIZE) {
    const { cols, rows } = validateTerminalSize(m.cols, m.rows);
    const o = be(4, (v) => v.setUint16(0, cols, false));
    viewOf(o).setUint16(2, rows, false);
    return send(o);
  }
  if (m.type === CLOSE) {
    if (!intIn(m.code, 0, 0xffff)) fail("invalid_payload", "Bad code.");
    if (!isReason(m.reason)) fail("invalid_close_reason", "Bad reason.");
    const text = enc.encode(m.reason);
    const o = be(2 + text.byteLength, (v) => v.setUint16(0, m.code, false));
    o.set(text, 2);
    return send(o);
  }
  if (m.nonce !== undefined && m.nonce.byteLength !== 8) fail("invalid_payload", "Bad nonce.");
  return send(m.nonce ?? EMPTY);
}

export function decodeRelayMessage(bytes: Uint8Array) {
  const { type, streamId, payload } = decodeRelayFrame(bytes);
  checkStream(streamId, type);
  const v = viewOf(payload);
  const len = payload.byteLength;
  if (type === OPEN_PTY) {
    const raw = parseJson(payload);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("invalid_payload", "Not object.");
    const obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj)) if (!ptyKeys.has(k)) fail("invalid_payload", `Unexpected: ${k}.`);
    const s = clampTerminalSize(obj.cols as number, obj.rows as number);
    const cwd = checkCwd(obj.cwd);
    return { type, streamId, ...(cwd === undefined ? s : { ...s, cwd }) } satisfies RelayMessage;
  }
  if (type === OPEN_TCP) {
    if (len !== 2) fail("invalid_payload", "Bad OPEN_TCP.");
    return { type, streamId, port: validateRelayPort(v.getUint16(0, false)) } satisfies RelayMessage;
  }
  if (type === OPEN_OK)
    return len === 0 ? ({ type, streamId } satisfies RelayMessage) : fail("invalid_payload", "Bad.");
  if (type === DATA)
    return len <= MAX_DATA_CHUNK
      ? ({ type, streamId, data: payload } satisfies RelayMessage)
      : fail("oversized_frame", "Big.");
  if (type === CREDIT) {
    if (len !== 4 || v.getUint32(0, false) < 1) fail("invalid_payload", "Bad CREDIT.");
    return { type, streamId, bytes: v.getUint32(0, false) } satisfies RelayMessage;
  }
  if (type === RESIZE) {
    if (len !== 4) fail("invalid_payload", "Bad RESIZE.");
    const s = validateTerminalSize(v.getUint16(0, false), v.getUint16(2, false));
    return { type, streamId, ...s } satisfies RelayMessage;
  }
  if (type === CLOSE) {
    if (len < 2) fail("invalid_payload", "Short CLOSE.");
    const reason = utf8(payload.subarray(2));
    if (!isReason(reason)) fail("invalid_close_reason", "Bad reason.");
    return { type, streamId, code: v.getUint16(0, false), reason } satisfies RelayMessage;
  }
  if (len !== 0 && len !== 8) fail("invalid_payload", "Bad PING/PONG.");
  return (len === 8 ? { type, streamId: 0, nonce: payload } : { type, streamId: 0 }) satisfies RelayMessage;
}

export class StreamWindow {
  sendAvailable: number;
  receiveAvailable: number;
  pendingCredit = 0;
  #inFlight = 0;
  readonly #watermark: number;
  constructor(initialWindow = INITIAL_STREAM_WINDOW, watermark = CREDIT_WATERMARK) {
    if (!intIn(initialWindow, 1, U32) || !intIn(watermark, 1, initialWindow)) throw new RangeError("Invalid window.");
    this.sendAvailable = initialWindow;
    this.receiveAvailable = initialWindow;
    this.#watermark = watermark;
  }
  canSend(n: number) {
    if (!intIn(n, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError("Bad byte count.");
    return n <= this.sendAvailable;
  }
  consumeSend(n: number) {
    if (!this.canSend(n)) return false;
    this.sendAvailable -= n;
    return true;
  }
  replenishSend(n: number) {
    if (!intIn(n, 1, U32)) throw new RangeError("Bad credit.");
    if (this.sendAvailable + n > U32) fail("invalid_payload", "Window overflow.");
    this.sendAvailable += n;
    return this.sendAvailable;
  }
  recordReceived(n: number) {
    if (!intIn(n, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError("Bad byte count.");
    if (n > this.receiveAvailable) return false;
    this.receiveAvailable -= n;
    this.#inFlight += n;
    return true;
  }
  acknowledgeReceived(n: number) {
    if (!intIn(n, 0, this.#inFlight)) throw new RangeError("Ack exceeds in-flight.");
    this.#inFlight -= n;
    this.pendingCredit += n;
    if (this.pendingCredit < this.#watermark) return 0;
    const grant = this.pendingCredit;
    this.pendingCredit = 0;
    this.receiveAvailable += grant;
    return grant;
  }
}
