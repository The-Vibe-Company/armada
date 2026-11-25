import { expect, test } from "bun:test";
import { sandboxRelayOperations } from "@armada/core/contract";
import { RELAY_TICKET_ERRORS, relayTicketRequest, relayTicketResponse } from "@armada/core/contract/sandbox-relay";
import * as r from "@armada/core/relay";

const { RELAY_OPCODE: OP, RelayProtocolError, StreamWindow, encodeRelayFrame: f } = r;
const [enc, dec, u] = [r.encodeRelayMessage, r.decodeRelayMessage, (s: string) => new TextEncoder().encode(s)];
const errOf = (b: Uint8Array) => {
  try {
    dec(b);
  } catch (e) {
    return e instanceof RelayProtocolError ? e.code : "other";
  }
};

test("roundtrips every opcode with fixed 10-byte big-endian header and constants", () => {
  const { RELAY_PROTOCOL_VERSION: v, MAX_RELAY_FRAME: mf, MAX_DATA_CHUNK: md, INITIAL_STREAM_WINDOW: iw } = r;
  expect([v, mf, md, iw]).toEqual([1, 65_536, 32_768, 262_144]);
  const { CREDIT_WATERMARK: cw, MAX_PTYS_PER_SANDBOX: mp, MAX_TCP_PER_SANDBOX: mt, MAX_STREAMS_PER_SANDBOX: ms } = r;
  expect([cw, mp, mt, ms]).toEqual([65_536, 4, 16, 20]);
  const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const msgs: r.RelayMessage[] = [
    { type: OP.OPEN_PTY, streamId: 1, cols: 120, rows: 40, cwd: "/home/user/repo" },
    { type: OP.OPEN_PTY, streamId: 2, cols: 80, rows: 24 },
    { type: OP.OPEN_TCP, streamId: 3, port: 8080 },
    { type: OP.OPEN_OK, streamId: 3 },
    { type: OP.DATA, streamId: 4, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
    { type: OP.CREDIT, streamId: 4, bytes: 65_536 },
    { type: OP.RESIZE, streamId: 1, cols: 132, rows: 50 },
    ...r.RELAY_CLOSE_REASONS.map((reason, i) => ({ type: OP.CLOSE, streamId: i, code: 1000 + i, reason })),
    { type: OP.PING, streamId: 0 },
    { type: OP.PING, streamId: 0, nonce },
    { type: OP.PONG, streamId: 0 },
    { type: OP.PONG, streamId: 0, nonce },
  ];
  for (const m of msgs) {
    const w = enc(m);
    const pad = new Uint8Array(w.byteLength + 6);
    pad.set(w, 3);
    expect(dec(pad.subarray(3, 3 + w.byteLength))).toEqual(m);
  }
  const tcp = enc({ type: OP.OPEN_TCP, streamId: 0x01020304, port: 3000 });
  expect(tcp).toEqual(new Uint8Array([1, 2, 1, 2, 3, 4, 0, 0, 0, 2, 0x0b, 0xb8]));
});

test("rejects malformed, truncated, oversized, bad-version, and invalid payloads", () => {
  const ok = enc({ type: OP.OPEN_TCP, streamId: 1, port: 5173 });
  const mut = (i: number, v: number) => Uint8Array.from(ok, (b, idx) => (idx === i ? v : b));
  const bad: [Uint8Array, r.RelayProtocolErrorCode][] = [
    [new Uint8Array(9), "truncated_frame"],
    [new Uint8Array(r.MAX_RELAY_FRAME + 1), "oversized_frame"],
    [mut(0, 2), "unsupported_version"],
    [mut(1, 0x0a), "unknown_opcode"],
    [mut(9, 10), "truncated_frame"],
    [new Uint8Array([...ok, 0xff]), "invalid_payload"],
    [new Uint8Array([1, OP.DATA, 0, 0, 0, 1, 0, 1, 0, 0]), "oversized_frame"],
    [f(OP.DATA, 1, new Uint8Array(r.MAX_DATA_CHUNK + 1)), "oversized_frame"],
    [f(OP.OPEN_TCP, 1, new Uint8Array([0, 0])), "invalid_port"],
    [f(OP.OPEN_TCP, 1, new Uint8Array([0, 80, 0])), "invalid_payload"],
    [f(OP.OPEN_OK, 1, new Uint8Array([1])), "invalid_payload"],
    [f(OP.CREDIT, 1, new Uint8Array(4)), "invalid_payload"],
    [f(OP.RESIZE, 1, new Uint8Array([0x01, 0xf5, 0, 24])), "invalid_terminal_size"],
    [f(OP.CLOSE, 1, new Uint8Array([0, 0, 0x62, 0x61, 0x64])), "invalid_close_reason"],
    [f(OP.CLOSE, 1, new Uint8Array([0, 0, 0xff, 0xfe])), "invalid_payload"],
    [f(OP.PING, 0, new Uint8Array(4)), "invalid_payload"],
    [f(OP.PING, 1), "invalid_stream_id"],
    [f(OP.OPEN_TCP, 0, new Uint8Array([0, 80])), "invalid_stream_id"],
    [f(OP.OPEN_PTY, 1, u('{"cols":80,"rows":24,"host":"127.0.0.1"}')), "invalid_payload"],
    [f(OP.OPEN_PTY, 1, u('{"cols":80,"rows":24,"cwd":"/a\\u0000"}')), "invalid_payload"],
  ];
  for (const [b, code] of bad) expect(errOf(b)).toBe(code);
  expect(() => f(OP.DATA, 1, new Uint8Array(r.MAX_RELAY_FRAME - 9))).toThrow(RelayProtocolError);
});

test("enforces port bounds, terminal bounds, OPEN_PTY clamping, and StreamWindow credits", () => {
  expect([r.validateRelayPort(1), r.validateRelayPort(65_535)]).toEqual([1, 65_535]);
  for (const p of [0, -1, 65_536, 80.5, Number.NaN]) expect(() => r.validateRelayPort(p)).toThrow(RelayProtocolError);
  expect(r.validateTerminalSize(1, 1)).toEqual({ cols: 1, rows: 1 });
  expect(r.validateTerminalSize(500, 200)).toEqual({ cols: 500, rows: 200 });
  for (const d of ["0,24", "501,24", "80,0", "80,201", "80.5,24"]) {
    const [c, rows] = d.split(",").map(Number);
    expect(() => r.validateTerminalSize(c!, rows!)).toThrow(RelayProtocolError);
  }
  expect(dec(enc({ type: OP.OPEN_PTY, streamId: 1, cols: 999, rows: 0 }))).toMatchObject({ cols: 500, rows: 1 });
  expect(dec(f(OP.OPEN_PTY, 1, u('{"cols":0,"rows":999}')))).toMatchObject({ cols: 1, rows: 200 });
  expect(() => r.clampTerminalSize(Number.NaN, 24)).toThrow(RelayProtocolError);
  const w = new StreamWindow();
  for (let i = 0; i < 8; i++) expect(w.consumeSend(r.MAX_DATA_CHUNK)).toBe(true);
  expect([w.sendAvailable, w.canSend(1), w.consumeSend(1)]).toEqual([0, false, false]);
  expect(w.replenishSend(r.CREDIT_WATERMARK)).toBe(r.CREDIT_WATERMARK);
  expect([w.recordReceived(r.MAX_DATA_CHUNK), w.acknowledgeReceived(r.MAX_DATA_CHUNK)]).toEqual([true, 0]);
  expect([w.recordReceived(r.MAX_DATA_CHUNK), w.acknowledgeReceived(r.MAX_DATA_CHUNK)]).toEqual([true, 65_536]);
  expect([w.pendingCredit, w.receiveAvailable, w.recordReceived(262_145)]).toEqual([0, 262_144, false]);
  expect(() => w.acknowledgeReceived(1)).toThrow(RangeError);
  expect(() => w.replenishSend(0xffff_ffff)).toThrow(RelayProtocolError);
  expect(() => new StreamWindow(0, 1)).toThrow(RangeError);
  expect(() => new StreamWindow(10, 11)).toThrow(RangeError);
});

test("validates sandboxRelayOperations.mintTicket contract", () => {
  const op = sandboxRelayOperations.mintTicket;
  expect(op.route).toEqual({ method: "POST", path: "/api/v1/sandboxes/{id}/relay-ticket" });
  expect(op.errors).toContain("relay_unavailable");
  expect(RELAY_TICKET_ERRORS).toContain("relay_unavailable");
  const ok = (x: unknown) => relayTicketRequest.safeParse(x).success;
  expect(ok({ mode: "pty" }) && ok({ mode: "pty", cwd: "/tmp", org: "acme" }) && ok({ mode: "tcp" })).toBe(true);
  expect(ok({ mode: "tcp", port: 5432 }) && ok({ mode: "preview", port: 3000 })).toBe(true);
  expect(ok({ mode: "preview" }) || ok({ mode: "preview", port: 0 }) || ok({ mode: "preview", port: 65_536 })).toBe(
    false,
  );
  expect(
    ok({ mode: "pty", port: 3000 }) || ok({ mode: "tcp", cwd: "/tmp" }) || ok({ mode: "tcp", host: "127.0.0.1" }),
  ).toBe(false);
  expect(ok({ mode: "pty", cwd: "/a\0b" }) || ok({ mode: "pty", org: " " })).toBe(false);
  const url = { wsUrl: "wss://relay.example/v1/connect", expiresAt: "2026-11-25T22:00:00.000Z" };
  const full = { ...url, ticket: "rly_sample", bootstrapUrl: "https://p.example/b", previewUrl: "https://s.p.example" };
  expect(relayTicketResponse.safeParse(full).success).toBe(true);
  expect(relayTicketResponse.safeParse({ ...full, wsUrl: "https://not-ws.example" }).success).toBe(false);
});
