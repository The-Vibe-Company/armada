import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeRelayMessage, encodeRelayMessage, RELAY_OPCODE } from "@armada/core/relay";
import type { ServerWebSocket } from "bun";
import { createRelayHub, type RelayClock, type RelaySocketData } from "../src/relay-hub.ts";
import { createRelayPreview, type PreviewWsSocketData } from "../src/relay-preview.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { sqlOver } from "../src/sql.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDb = rowOnlyDatabase();
const enc = new TextEncoder();
const dec = new TextDecoder();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function fakeClock(now = 1_700_000_000_000) {
  const tasks = new Set<{ at: number; interval: number | undefined; cb: () => void }>();
  const add = (ms: number, cb: () => void, interval?: number) => {
    const t = { at: now + ms, interval, cb };
    tasks.add(t);
    return () => tasks.delete(t);
  };
  const clock: RelayClock = { now: () => now, every: (ms, cb) => add(ms, cb, ms), after: (ms, cb) => add(ms, cb) };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (
      let due = [...tasks].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      due;
      due = [...tasks].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
    ) {
      now = due.at;
      if (due.interval) due.at += due.interval;
      else tasks.delete(due);
      due.cb();
      await new Promise((r) => setImmediate(r));
    }
    now = target;
  };
  return { clock, advance, tasks };
}

function wsServerFrame(opcode: number, payload: Uint8Array, fin = true) {
  const len = payload.byteLength;
  const hdr = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const o = new Uint8Array(hdr + len);
  o[0] = (fin ? 0x80 : 0) | opcode;
  if (hdr === 2) o[1] = len;
  else if (hdr === 4) {
    o[1] = 126;
    o[2] = (len >>> 8) & 0xff;
    o[3] = len & 0xff;
  } else {
    o[1] = 127;
    new DataView(o.buffer).setUint32(6, len >>> 0, false);
  }
  o.set(payload, hdr);
  return o;
}

function decodeClientFrame(buf: Uint8Array) {
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  const len = buf[1]! & 0x7f;
  const mask = buf.subarray(2, 6);
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = buf[6 + i]! ^ mask[i & 3]!;
  return { opcode, masked, text: dec.decode(payload) };
}

type TcpPeer = {
  id: number;
  port: number;
  sendOpenOk: () => void;
  sendData: (b: Uint8Array) => void;
  close: (code?: number, reason?: "eof" | "refused" | "revoked") => void;
};

async function fixture(onTcp: (s: TcpPeer, received: Uint8Array, credits: number[]) => void) {
  const { db, people } = await sharedDb();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime,expires_at)
     select $1,id,org_id,owner_id,'prev-boat','codex','ready',true,now()+interval '1 hour' from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  const sql = sqlOver({
    unsafe: async (q, v) => (await db.query(q, v)).rows,
    begin: (work) => db.transaction((tx) => work({ unsafe: async (q, v) => (await tx.query(q, v)).rows })),
  });
  const timer = fakeClock();
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const hub = createRelayHub({
    sql,
    authority,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
    dashboardUrl: "https://dashboard.example.com",
    clock: timer.clock,
  });
  const owner = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const preview = createRelayPreview({
    relayHub: hub,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
    clock: timer.clock,
    authenticate: async (req) =>
      req.headers.get("authorization") === "Bearer owner-tok" ? { ok: true, caller: owner } : { ok: false },
  });
  const enrolled = await authority.enrol(
    (await authority.issue({ sandboxId: id, ownerId: people.owner, configuration: {} })).enrolmentToken,
  );
  let rtData: RelaySocketData | undefined;
  expect(
    await hub.upgradeRuntime(
      new Request(`${PUBLIC_URL}/api/runtime/relay`, {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${enrolled.runtimeToken}`,
          "x-armada-runtime-epoch": enrolled.epoch,
        },
      }),
      (d) => {
        rtData = d;
        return true;
      },
    ),
  ).toBeUndefined();
  const streams = new Map<number, { port: number; buf: Uint8Array; credits: number[] }>();
  const deliver = (msg: Parameters<typeof encodeRelayMessage>[0]) =>
    void hub.websocket.message(rtWs, Buffer.from(encodeRelayMessage(msg)));
  const rtWs = {
    data: rtData!,
    send(raw: Uint8Array) {
      const m = decodeRelayMessage(new Uint8Array(raw));
      if (m.type === RELAY_OPCODE.OPEN_TCP) {
        streams.set(m.streamId, { port: m.port, buf: new Uint8Array(0), credits: [] });
        queueMicrotask(() => deliver({ type: RELAY_OPCODE.OPEN_OK, streamId: m.streamId }));
      } else if (m.type === RELAY_OPCODE.DATA) {
        const s = streams.get(m.streamId);
        if (!s) return raw.byteLength;
        const next = new Uint8Array(s.buf.byteLength + m.data.byteLength);
        next.set(s.buf, 0);
        next.set(m.data, s.buf.byteLength);
        s.buf = next;
        const api: TcpPeer = {
          id: m.streamId,
          port: s.port,
          sendOpenOk: () => deliver({ type: RELAY_OPCODE.OPEN_OK, streamId: m.streamId }),
          sendData: (b) => deliver({ type: RELAY_OPCODE.DATA, streamId: m.streamId, data: b }),
          close: (code = 1000, reason = "eof") =>
            deliver({ type: RELAY_OPCODE.CLOSE, streamId: m.streamId, code, reason }),
        };
        queueMicrotask(() => onTcp(api, s.buf, s.credits));
      } else if (m.type === RELAY_OPCODE.CREDIT) streams.get(m.streamId)?.credits.push(m.bytes);
      else if (m.type === RELAY_OPCODE.CLOSE) streams.delete(m.streamId);
      return raw.byteLength;
    },
    close() {},
  } as unknown as ServerWebSocket<RelaySocketData>;
  hub.websocket.open?.(rtWs);
  const mint = async (input: { mode: "pty" | "tcp" | "preview"; port?: number }) => {
    const r = await hub.mintTicket(owner, id, input);
    if (!r.ok) throw Error(r.code);
    return r;
  };
  const call = (path: string, init?: RequestInit) =>
    preview.route(new Request(`${PUBLIC_URL}${path}`, init)).then((r) => r!);
  return { db, id, hub, preview, timer, mint, call };
}

test("POST enter cookie scoping, header stripping, Set-Cookie/Location rewrite, chunked streaming + credit, taint & edge cases", async () => {
  const seenRequests: string[] = [];
  const seenCredits: number[][] = [];
  const handled = new Set<number>();
  const f = await fixture((s, received, credits) => {
    const text = dec.decode(received);
    if (handled.has(s.id) || !text.includes("\r\n\r\n")) return;
    if (text.startsWith("POST /stream ") && !text.endsWith("0\r\n\r\n")) return;
    handled.add(s.id);
    seenRequests.push(text);
    seenCredits.push(credits);
    if (text.startsWith("GET /redirect ")) {
      s.sendData(
        enc.encode(
          "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:3000/home?x=1\r\n" +
            "Set-Cookie: app_sid=xyz; Path = /; Domain = localhost; HttpOnly\r\n" +
            "Set-Cookie: armada_preview=evil; Path=/\r\nSet-Cookie: __Host-sb-tok=1; Path=/\r\nContent-Length: 0\r\n\r\n",
        ),
      );
      return;
    }
    if (text.startsWith("GET /app/rel ")) {
      s.sendData(enc.encode("HTTP/1.1 302 Found\r\nLocation: step2?a=1\r\nContent-Length: 0\r\n\r\n"));
      return;
    }
    if (text.startsWith("GET /rootrel ")) {
      s.sendData(enc.encode("HTTP/1.1 302 Found\r\nLocation: /login?next=/app\r\nContent-Length: 0\r\n\r\n"));
      return;
    }
    if (text.startsWith("GET /ext ")) {
      s.sendData(
        enc.encode("HTTP/1.1 302 Found\r\nLocation: https://external.example/auth\r\nContent-Length: 0\r\n\r\n"),
      );
      return;
    }
    if (text.startsWith("GET /badhdr ")) {
      s.sendData(new Uint8Array([...enc.encode("HTTP/1.1 200 OK\r\nX-Bad: a"), 0x00, ...enc.encode("b\r\n\r\n")]));
      return;
    }
    if (text.startsWith("GET /dupopen ")) {
      s.sendOpenOk();
      return;
    }
    if (text.startsWith("GET /refused ")) {
      s.close(1000, "refused");
      return;
    }
    if (text.startsWith("POST /trunc ")) return;
    if (text.startsWith("POST /empty ")) {
      s.sendData(enc.encode("HTTP/1.1 204 No Content\r\n\r\n"));
      return;
    }
    const big = "A".repeat(70_000);
    const resp = enc.encode(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\nConnection: keep-alive, x-hop\r\nX-Hop: drop\r\n\r\n5\r\nhello\r\n${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`,
    );
    s.sendData(resp.subarray(0, 20));
    for (let i = 20; i < resp.byteLength; i += 16_384) s.sendData(resp.subarray(i, i + 16_384));
  });
  try {
    const t1 = await f.mint({ mode: "preview", port: 3000 });
    const pty = await f.mint({ mode: "pty" });
    const scope = `/api/v1/sandboxes/${f.id}/ports/3000/`;
    expect([t1.bootstrapUrl, t1.previewUrl]).toEqual([
      `${PUBLIC_URL}/api/v1/relay/preview/enter`,
      `${PUBLIC_URL}${scope}`,
    ]);
    expect((await f.call(`/api/v1/relay/preview/enter?ticket=${t1.ticket}`)).status).toBe(405);
    expect(
      (
        await f.call("/api/v1/relay/preview/enter?x=1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: t1.ticket }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call("/api/v1/relay/preview/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: pty.ticket }),
        })
      ).status,
    ).toBe(403);
    const entered = await f.call("/api/v1/relay/preview/enter", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: t1.ticket }).toString(),
    });
    expect([entered.status, entered.headers.get("location")]).toEqual([303, scope]);
    const setCookie = entered.headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0]!;
    expect(setCookie).toContain(`HttpOnly; Secure; SameSite=Lax; Max-Age=900; Path=${scope}`);
    expect(
      (
        await f.call("/api/v1/relay/preview/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: t1.ticket }),
        })
      ).status,
    ).toBe(401);
    for (const bad of ["0", "65536", "abc", "-1"])
      expect((await f.call(`/api/v1/sandboxes/${f.id}/ports/${bad}/`)).status).toBe(400);
    expect((await f.call(`/api/v1/sandboxes/${f.id}/ports/5173/`, { headers: { cookie: cookiePair } })).status).toBe(
      401,
    );

    const redir = await f.call(`${scope}redirect`, {
      headers: {
        cookie: `${cookiePair}; app_theme=dark; sb-auth=secret; __Secure-sb-x=1`,
        authorization: "Bearer no-leak",
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "drop",
      },
    });
    expect([redir.status, redir.headers.get("location"), redir.headers.get("x-content-type-options")]).toEqual([
      302,
      `${scope}home?x=1`,
      "nosniff",
    ]);
    expect(redir.headers.getSetCookie()).toEqual([`app_sid=xyz; HttpOnly; Path=${scope}`]);
    expect(seenRequests[0]).toContain("Host: 127.0.0.1:3000\r\n");
    expect(seenRequests[0]).toContain("Cookie: app_theme=dark\r\n");
    for (const leaked of ["no-leak", "armada_preview", "sb-auth", "__Secure-sb-x", "x-secret-hop"])
      expect(seenRequests[0]).not.toContain(leaked);

    expect((await f.call(`${scope}app/rel`, { headers: { cookie: cookiePair } })).headers.get("location")).toBe(
      "step2?a=1",
    );
    expect((await f.call(`${scope}rootrel`, { headers: { cookie: cookiePair } })).headers.get("location")).toBe(
      `${scope}login?next=/app`,
    );
    expect((await f.call(`${scope}ext`, { headers: { cookie: cookiePair } })).headers.get("location")).toBe(
      "https://external.example/auth",
    );
    expect((await f.call(`${scope}badhdr`, { headers: { cookie: cookiePair } })).status).toBe(502);
    expect((await f.call(`${scope}dupopen`, { headers: { cookie: cookiePair } })).status).toBe(502);
    expect((await f.call(`${scope}refused`, { headers: { cookie: cookiePair } })).status).toBe(502);
    expect((await f.call(`${scope}empty`, { method: "POST", headers: { cookie: cookiePair } })).status).toBe(204);
    expect(seenRequests.at(-1)).toContain("Content-Length: 0\r\n");

    const trunc = await f.call(`${scope}trunc`, {
      method: "POST",
      headers: { cookie: cookiePair, "content-length": "100" },
      body: "short",
    });
    expect(trunc.status).toBe(400);

    const streamed = await f.call(`${scope}stream`, {
      method: "POST",
      headers: { authorization: "Bearer owner-tok" },
      body: "req-body",
    });
    expect([streamed.status, streamed.headers.get("x-hop"), streamed.headers.get("x-content-type-options")]).toEqual([
      200,
      null,
      "nosniff",
    ]);
    expect(await streamed.text()).toBe(`hello${"A".repeat(70_000)}`);
    expect(seenRequests.at(-1)).toContain("req-body");
    expect(seenCredits.at(-1)!.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(65_536);

    await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
    expect((await f.call(scope, { headers: { cookie: cookiePair } })).status).toBe(403);
  } finally {
    await f.preview.stop();
    await f.hub.stop();
  }
});

test("WS preview upgrade checks Origin + cookie, handles post-101 race, >256KiB frames, pings, and closes on taint", async () => {
  const clientFrames: ReturnType<typeof decodeClientFrame>[] = [];
  let wsUpgraded = false;
  let wsOffset = 0;
  let largeSent = false;
  let creditsSeen = 0;
  const f = await fixture((s, received, credits) => {
    if (!wsUpgraded) {
      const text = dec.decode(received);
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) return;
      wsUpgraded = true;
      wsOffset = end + 4;
      const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(text)![1]!;
      expect(text).toContain("Sec-WebSocket-Protocol: vite-hmr");
      expect(text).not.toContain("armada_preview");
      const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      s.sendData(
        enc.encode(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
        ),
      );
      s.sendData(wsServerFrame(0x1, enc.encode("hmr:connected")));
      return;
    }
    const delta = received.subarray(wsOffset);
    if (!delta.byteLength) return;
    wsOffset = received.byteLength;
    const frame = decodeClientFrame(delta);
    clientFrames.push(frame);
    if (frame.opcode === 0x1 && !largeSent) {
      largeSent = true;
      const bigPayload = enc.encode("B".repeat(300_000));
      const bigFrame = wsServerFrame(0x1, bigPayload);
      for (let i = 0; i < bigFrame.byteLength; i += 32_768) s.sendData(bigFrame.subarray(i, i + 32_768));
      creditsSeen = credits.reduce((a, b) => a + b, 0);
      s.sendData(wsServerFrame(0x1, enc.encode("part1-"), false));
      s.sendData(wsServerFrame(0x0, enc.encode("part2"), true));
      s.sendData(wsServerFrame(0x9, enc.encode("ping")));
    }
  });
  try {
    const t = await f.mint({ mode: "preview", port: 5173 });
    const entered = await f.call("/api/v1/relay/preview/enter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: t.ticket }),
    });
    const cookiePair = entered.headers.get("set-cookie")!.split(";")[0]!;
    const wsUrl = `${PUBLIC_URL}/api/v1/sandboxes/${f.id}/ports/5173/@vite/client`;
    expect(
      (await f.preview.upgradeWebSocket(
        new Request(wsUrl, { headers: { upgrade: "websocket", origin: "https://evil.example", cookie: cookiePair } }),
        () => true,
      ))!.status,
    ).toBe(403);
    expect(
      (await f.preview.upgradeWebSocket(
        new Request(wsUrl, { headers: { upgrade: "websocket", origin: PUBLIC_URL } }),
        () => true,
      ))!.status,
    ).toBe(401);

    let wsData: PreviewWsSocketData | undefined;
    let negotiated: Record<string, string> | undefined;
    expect(
      await f.preview.upgradeWebSocket(
        new Request(wsUrl, {
          headers: {
            upgrade: "websocket",
            origin: PUBLIC_URL,
            cookie: cookiePair,
            "sec-websocket-protocol": "vite-hmr",
          },
        }),
        (d, h) => {
          wsData = d;
          negotiated = h;
          return true;
        },
      ),
    ).toBeUndefined();
    expect(negotiated).toEqual({ "sec-websocket-protocol": "vite-hmr" });

    const received: (string | Uint8Array)[] = [];
    let closedCode: number | undefined;
    let pingCount = 0;
    const browserWs = {
      data: wsData!,
      send: (v: string | Uint8Array) => {
        received.push(v);
        return typeof v === "string" ? v.length : v.byteLength;
      },
      ping: () => {
        pingCount++;
        return 0;
      },
      close: (c = 1000) => {
        closedCode = c;
      },
    } as unknown as ServerWebSocket<PreviewWsSocketData>;
    f.preview.websocket.open?.(browserWs);
    expect(received).toEqual(["hmr:connected"]);
    f.preview.websocket.message(browserWs, "update?");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(clientFrames).toEqual([
      { opcode: 0x1, masked: true, text: "update?" },
      { opcode: 0xa, masked: true, text: "ping" },
    ]);
    expect(received).toEqual(["hmr:connected", "B".repeat(300_000), "part1-part2"]);
    expect(creditsSeen).toBeGreaterThanOrEqual(262_144);
    await f.timer.advance(30_000);
    expect(pingCount).toBe(1);
    await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
    await f.timer.advance(30_000);
    expect(closedCode).toBe(4403);
  } finally {
    await f.preview.stop();
    await f.hub.stop();
  }
});
