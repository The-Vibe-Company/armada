import { describe, expect, test } from "bun:test";
import * as r from "@armada/core/relay";
import {
  canUseSandboxRelay,
  createRelayClient,
  parseRelayPort,
  portForwardCommand,
  type RelayClientState,
  type RelayWebSocketLike,
  submitPreviewBootstrap,
} from "./relay-client.ts";

const { OPEN_PTY, OPEN_OK, DATA, CREDIT, RESIZE, CLOSE, PING, PONG } = r.RELAY_OPCODE;

function setup(overrides: Partial<Parameters<typeof createRelayClient>[0]> = {}) {
  const sockets: {
    url: string;
    ws: RelayWebSocketLike & { sent: (string | Uint8Array)[]; emit(t: string, ev?: unknown): void };
  }[] = [];
  const states: RelayClientState[] = [],
    received: { data: Uint8Array; ack: () => void }[] = [],
    timers: { cb: () => void; cancelled: boolean }[] = [];
  const client = createRelayClient({
    mintTicket: async () => ({
      ok: true,
      ticket: {
        ticket: "armada_relay_test",
        wsUrl: "wss://relay.example/api/v1/relay/ws",
        expiresAt: "2026-11-26T01:00:00Z",
      },
    }),
    onState: (s) => states.push(s),
    onData: (data, ack) => received.push({ data, ack }),
    createWebSocket: (url) => {
      const listeners = new Map<string, ((ev?: any) => void)[]>();
      const ws = {
        readyState: 0,
        binaryType: "",
        sent: [] as (string | Uint8Array)[],
        addEventListener: (type: string, fn: (ev?: any) => void) =>
          void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        send: (data: string | Uint8Array) => void ws.sent.push(typeof data === "string" ? data : new Uint8Array(data)),
        close() {
          ws.readyState = 3;
        },
        emit(type: string, ev?: unknown) {
          if (type === "open") ws.readyState = 1;
          if (type === "close") ws.readyState = 3;
          for (const fn of listeners.get(type) ?? []) fn(ev);
        },
      };
      sockets.push({ url, ws });
      return ws;
    },
    timer: {
      after: (_ms, cb) => {
        const t = { cb, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
    },
    ...overrides,
  });
  return {
    client,
    sockets,
    states,
    received,
    flush: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.cb();
    },
  };
}

describe("relay-client", () => {
  test("authenticates via first JSON frame and handles PTY framing, credits, resize, ping and close", async () => {
    const { client, sockets, states, received, flush } = setup({ cwd: "/workspace" });
    await client.connect(120, 40);
    const { url, ws } = sockets[0]!;
    expect([url, ws.binaryType]).toEqual(["wss://relay.example/api/v1/relay/ws", "arraybuffer"]);

    ws.emit("open");
    expect(ws.sent[0]).toBe(JSON.stringify({ type: "auth", ticket: "armada_relay_test" }));
    ws.emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
    expect(r.decodeRelayMessage(ws.sent[1] as Uint8Array)).toEqual({
      type: OPEN_PTY,
      streamId: 1,
      cols: 120,
      rows: 40,
      cwd: "/workspace",
    });

    client.resize(132, 42);
    ws.emit("message", { data: r.encodeRelayMessage({ type: OPEN_OK, streamId: 1 }).buffer });
    expect(states.at(-1)).toEqual({ phase: "connected", canReconnect: true });
    expect(r.decodeRelayMessage(ws.sent[2] as Uint8Array)).toEqual({ type: RESIZE, streamId: 1, cols: 132, rows: 42 });

    client.resize(140, 45);
    client.resize(150, 50);
    expect(ws.sent).toHaveLength(3);
    flush();
    expect(r.decodeRelayMessage(ws.sent[3] as Uint8Array)).toEqual({ type: RESIZE, streamId: 1, cols: 150, rows: 50 });

    const chunk = new Uint8Array(r.MAX_DATA_CHUNK).fill(65);
    for (let i = 0; i < Math.ceil(r.CREDIT_WATERMARK / r.MAX_DATA_CHUNK); i++) {
      ws.emit("message", { data: r.encodeRelayMessage({ type: DATA, streamId: 1, data: chunk }).buffer });
      received.at(-1)!.ack();
    }
    expect(r.decodeRelayMessage(ws.sent.at(-1) as Uint8Array)).toEqual({
      type: CREDIT,
      streamId: 1,
      bytes: r.CREDIT_WATERMARK,
    });

    const before = ws.sent.length;
    client.sendInput(new Uint8Array(r.INITIAL_STREAM_WINDOW + 16).fill(66));
    expect(ws.sent.length - before).toBe(r.INITIAL_STREAM_WINDOW / r.MAX_DATA_CHUNK);
    ws.emit("message", { data: r.encodeRelayMessage({ type: CREDIT, streamId: 1, bytes: 1024 }).buffer });
    expect((r.decodeRelayMessage(ws.sent.at(-1) as Uint8Array) as { data: Uint8Array }).data.byteLength).toBe(16);

    const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    ws.emit("message", { data: r.encodeRelayMessage({ type: PING, nonce }).buffer });
    expect(r.decodeRelayMessage(ws.sent.at(-1) as Uint8Array)).toEqual({ type: PONG, streamId: 0, nonce });

    ws.emit("message", { data: r.encodeRelayMessage({ type: CLOSE, streamId: 1, code: 0, reason: "eof" }).buffer });
    expect(states.at(-1)).toEqual({ phase: "disconnected", message: "Shell exited.", canReconnect: true });
  });

  test("handles mint errors, revoked close codes and reconnect transitions", async () => {
    let failMint = true;
    const { client, sockets, states } = setup({
      mintTicket: async () =>
        failMint
          ? { ok: false, error: "Sandbox is not ready for relay.", code: "sandbox_not_ready" }
          : {
              ok: true,
              ticket: {
                ticket: "armada_relay_2",
                wsUrl: "wss://relay.example/api/v1/relay/ws",
                expiresAt: "2026-11-26T01:00:00Z",
              },
            },
    });
    await client.connect(80, 24);
    expect(states.at(-1)).toEqual({ phase: "error", message: "Sandbox is not ready for relay.", canReconnect: true });
    failMint = false;
    await client.connect(80, 24, { reconnect: true });
    expect(states.some((s) => s.phase === "reconnecting")).toBe(true);
    sockets[0]!.ws.emit("close", { code: 4403 });
    expect(states.at(-1)).toEqual({
      phase: "error",
      message: "Relay access was revoked for this sandbox.",
      canReconnect: false,
    });
  });

  test("validates ports, eligibility, CLI command and hidden POST preview bootstrap", () => {
    expect([parseRelayPort("1"), parseRelayPort("3000"), parseRelayPort("65535")]).toEqual([
      { ok: true, port: 1 },
      { ok: true, port: 3000 },
      { ok: true, port: 65_535 },
    ]);
    for (const bad of ["", "0", "65536", "3000.5", "-1", "abc", "080"]) expect(parseRelayPort(bad).ok).toBe(false);
    expect(portForwardCommand("sb-1", 5173)).toBe("armada port-forward sb-1 5173");

    const base = {
      publicStatus: "ready",
      application_secret_tainted: false,
      stop_requested_at: null,
      deleted_at: null,
      provider: "modal",
      boat_runtime: false,
      runtime_transport: "dialout",
    };
    expect([
      canUseSandboxRelay(base),
      canUseSandboxRelay({ ...base, provider: "docker", runtime_transport: null }),
      canUseSandboxRelay({ ...base, application_secret_tainted: true }),
      canUseSandboxRelay({ ...base, publicStatus: "stopped" }),
    ]).toEqual([true, true, false, false]);

    const submitted: Record<string, string>[] = [];
    let removed = false;
    const fakeDoc = {
      createElement: (tag: string) =>
        tag === "form"
          ? ({
              style: {},
              children: [] as any[],
              appendChild(c: any) {
                this.children.push(c);
              },
              submit() {
                submitted.push({
                  action: this.action,
                  method: this.method,
                  target: this.target,
                  rel: this.rel,
                  name: this.children[0]?.name,
                  value: this.children[0]?.value,
                });
              },
              remove() {
                removed = true;
              },
            } as any)
          : ({} as any),
      body: { appendChild() {} },
    } as unknown as Document;

    expect(submitPreviewBootstrap("https://relay.example/enter?ticket=leak", "t", fakeDoc)).toBe(false);
    expect(submitPreviewBootstrap("https://relay.example/api/v1/relay/preview/enter", "t-1", fakeDoc)).toBe(true);
    expect(removed).toBe(true);
    expect(submitted).toEqual([
      {
        action: "https://relay.example/api/v1/relay/preview/enter",
        method: "POST",
        target: "_blank",
        rel: "noopener",
        name: "ticket",
        value: "t-1",
      },
    ]);
  });
});
