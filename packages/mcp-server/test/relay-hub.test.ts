import { expect, mock, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { decodeRelayMessage, encodeRelayMessage, RELAY_OPCODE } from "@armada/core/relay";
import type { ServerWebSocket } from "bun";
import { createRelayHub, type RelayClock, type RelaySocketData } from "../src/relay-hub.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { createRuntimeIdle } from "../src/runtime-idle.ts";
import { sqlOver } from "../src/sql.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY, PUBLIC_URL } from "./support.ts";

const sharedDb = rowOnlyDatabase(),
  DASHBOARD_URL = "https://dashboard.example.com";

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

function fakeSocket(data: RelaySocketData, onFrame?: (v: Uint8Array | string) => void) {
  const frames: (Uint8Array | string)[] = [],
    closed = Promise.withResolvers<number>();
  let code: number | undefined;
  const ws = {
    data,
    send: (v: Uint8Array | string) => {
      const c = typeof v === "string" ? v : new Uint8Array(v);
      frames.push(c);
      onFrame?.(c);
      return typeof v === "string" ? Buffer.byteLength(v) : v.byteLength;
    },
    close: (c = 1000) => {
      code = c;
      closed.resolve(c);
    },
  } as unknown as ServerWebSocket<RelaySocketData>;
  return { ws, frames, code: () => code, closed: closed.promise };
}

async function fixture() {
  const { db, people } = await sharedDb(),
    id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime,expires_at)
     select $1,id,org_id,owner_id,'relay-boat','codex','ready',true,now()+interval '1 hour'
     from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  const sql = sqlOver({
    unsafe: async (q, v) => (await db.query(q, v)).rows,
    begin: (work) => db.transaction((tx) => work({ unsafe: async (q, v) => (await tx.query(q, v)).rows })),
  });
  const timer = fakeClock(),
    authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
  const hub = createRelayHub({
    sql,
    authority,
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: PUBLIC_URL,
    dashboardUrl: DASHBOARD_URL,
    clock: timer.clock,
  });
  const owner = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "service" as const,
  };
  const admin = {
    userId: people.admin,
    orgs: [{ orgId: people.org, role: "admin" as const }],
    via: "service" as const,
  };
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ sandboxId: id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
  const openWs = async (
    upgrade: (accept: (d: RelaySocketData) => boolean) => Promise<Response | undefined>,
    onFrame?: (v: Uint8Array | string) => void,
  ) => {
    let data: RelaySocketData | undefined;
    expect(
      await upgrade((d) => {
        data = d;
        return true;
      }),
    ).toBeUndefined();
    const sock = fakeSocket(data!, onFrame);
    hub.websocket.open?.(sock.ws);
    return sock;
  };
  const connectRuntime = async (existing?: Awaited<ReturnType<typeof enrol>>, autoPong = false) => {
    const active = existing ?? (await enrol());
    const sock = await openWs(
      (accept) =>
        hub.upgradeRuntime(
          new Request(`${PUBLIC_URL}/api/runtime/relay`, {
            headers: {
              upgrade: "websocket",
              authorization: `Bearer ${active.runtimeToken}`,
              "x-armada-runtime-epoch": active.epoch,
            },
          }),
          accept,
        ),
      (f) => {
        if (autoPong && f instanceof Uint8Array && decodeRelayMessage(f).type === RELAY_OPCODE.PING)
          void hub.websocket.message(sock.ws, Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.PONG })));
      },
    );
    return { active, ...sock };
  };
  const upgradeClient = (headers: Record<string, string>, url = `${PUBLIC_URL}/api/v1/relay/ws`) =>
    hub.upgradeClient(new Request(url, { headers: { upgrade: "websocket", ...headers } }), () => true);
  const openClient = (headers: Record<string, string>) =>
    openWs((accept) =>
      hub.upgradeClient(
        new Request(`${PUBLIC_URL}/api/v1/relay/ws`, { headers: { upgrade: "websocket", ...headers } }),
        accept,
      ),
    );
  const mint = async (
    input: { mode: "pty" | "tcp" | "preview"; port?: number; cwd?: string },
    caller: typeof owner | typeof admin = owner,
  ) => {
    const r = await hub.mintTicket(caller, id, input);
    if (!r.ok) throw Error(r.code);
    return r.ticket;
  };
  return {
    db,
    sql,
    id,
    ownerId: people.owner,
    admin,
    authority,
    hub,
    timer,
    connectRuntime,
    upgradeClient,
    openClient,
    mint,
  };
}

test("enforces CSWSH Origin, query-string ban, replay protection, and 5s browser auth timeout", async () => {
  const f = await fixture();
  try {
    await f.connectRuntime();
    const t1 = await f.mint({ mode: "pty" });
    expect((await f.upgradeClient({ origin: "https://evil.example" }))?.status).toBe(403);
    expect((await f.upgradeClient({ origin: "https://evil.example", authorization: `Bearer ${t1}` }))?.status).toBe(
      403,
    );
    expect((await f.upgradeClient({}, `${PUBLIC_URL}/api/v1/relay/ws?ticket=${t1}`))?.status).toBe(400);
    expect((await f.upgradeClient({}))?.status).toBe(401);
    await f.openClient({ authorization: `Bearer ${t1}` });
    expect((await f.upgradeClient({ authorization: `Bearer ${t1}` }))?.status).toBe(401);
    const unauth = await f.openClient({ origin: DASHBOARD_URL });
    await f.timer.advance(5_000);
    expect(unauth.code()).toBe(4401);
    const browser = await f.openClient({ origin: DASHBOARD_URL }),
      t2 = await f.mint({ mode: "pty" });
    await f.hub.websocket.message(browser.ws, JSON.stringify({ type: "auth", ticket: t2 }));
    expect(browser.frames).toEqual([JSON.stringify({ type: "auth_ok" })]);
    const replay = await f.openClient({ origin: DASHBOARD_URL });
    await f.hub.websocket.message(replay.ws, JSON.stringify({ type: "auth", ticket: t2 }));
    expect(replay.code()).toBe(4401);
    await f.hub.stop();
    expect([browser.code(), f.timer.tasks.size]).toEqual([1012, 0]);
  } finally {
    await f.hub.stop();
  }
});

test("remaps stream IDs, enforces mode/port scope, tears down on disconnect/stop, and defers runtime-idle", async () => {
  const f = await fixture();
  try {
    const rt = await f.connectRuntime(undefined, true),
      promptId = crypto.randomUUID();
    const events = createRuntimeEvents(f.authority, ENCRYPTION_KEY);
    const ev: AgentEvent = { id: promptId, kind: "prompt", promptId, status: "finished", at: 1, text: "" };
    expect(
      (
        await events.route(
          new Request(`${PUBLIC_URL}/api/runtime/events`, {
            method: "POST",
            headers: { authorization: `Bearer ${rt.active.runtimeToken}`, "x-armada-runtime-epoch": rt.active.epoch },
            body: JSON.stringify({
              sandboxId: f.id,
              generation: rt.active.epoch,
              events: [{ sequence: 1, event: ev }],
            }),
          }),
        )
      )?.status,
    ).toBe(200);
    await f.db.query("update sandboxes set status='running',task_prompt_id=$2 where id=$1", [f.id, promptId]);

    const c1 = await f.openClient({ authorization: `Bearer ${await f.mint({ mode: "pty" })}` });
    const c2 = await f.openClient({ authorization: `Bearer ${await f.mint({ mode: "tcp", port: 3000 })}` });
    f.hub.websocket.message(
      c2.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.OPEN_PTY, streamId: 1, cols: 80, rows: 24 })),
    );
    f.hub.websocket.message(
      c2.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.OPEN_TCP, streamId: 2, port: 8080 })),
    );
    expect(c2.frames.map((b) => decodeRelayMessage(b as Uint8Array))).toMatchObject([
      { type: RELAY_OPCODE.CLOSE, streamId: 1, code: 4403, reason: "refused" },
      { type: RELAY_OPCODE.CLOSE, streamId: 2, code: 4403, reason: "refused" },
    ]);
    f.hub.websocket.message(
      c1.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.OPEN_PTY, streamId: 1, cols: 80, rows: 24 })),
    );
    f.hub.websocket.message(
      c2.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.OPEN_TCP, streamId: 1, port: 3000 })),
    );
    expect(rt.frames.map((b) => decodeRelayMessage(b as Uint8Array))).toMatchObject([
      { type: RELAY_OPCODE.OPEN_PTY, streamId: 1 },
      { type: RELAY_OPCODE.OPEN_TCP, streamId: 2, port: 3000 },
    ]);
    const payload = new Uint8Array([1, 2, 3]);
    await f.hub.websocket.message(
      rt.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.DATA, streamId: 2, data: payload })),
    );
    expect(decodeRelayMessage(c2.frames.at(-1) as Uint8Array)).toMatchObject({
      type: RELAY_OPCODE.DATA,
      streamId: 1,
      data: payload,
    });
    expect(c1.frames).toHaveLength(0);

    const checkpoint = mock(async () => ({
      id: f.id,
      requestId: "r",
      runtime: { kind: "armada" as const, epoch: rt.active.epoch },
      checkpoint: { state: "complete" as const, watermark: 1, acknowledgedSequence: 1 },
    }));
    let idleNow = 100_000;
    const idle = createRuntimeIdle(f.sql, ENCRYPTION_KEY, checkpoint, {
      delayMs: 10,
      now: () => idleNow,
      hasActiveRelay: (sid) => f.hub.hasActiveRelay(sid),
    });
    await idle.reconcileOne(new AbortController().signal);
    expect(checkpoint).not.toHaveBeenCalled();
    expect((await f.db.query("select status from sandboxes where id=$1", [f.id])).rows).toEqual([{ status: "ready" }]);
    f.hub.websocket.message(
      c1.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.CLOSE, streamId: 1, code: 1000, reason: "eof" })),
    );
    await f.timer.advance(60_000);
    expect(f.hub.hasActiveRelay(f.id)).toBe(true);
    expect(c1.frames.some((b) => b instanceof Uint8Array && decodeRelayMessage(b).type === RELAY_OPCODE.PING)).toBe(
      true,
    );
    expect(c2.frames.some((b) => b instanceof Uint8Array && decodeRelayMessage(b).type === RELAY_OPCODE.PING)).toBe(
      true,
    );
    idleNow += 60_000;
    await idle.reconcileOne(new AbortController().signal);
    expect(checkpoint).not.toHaveBeenCalled();
    f.hub.websocket.message(
      c2.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.CLOSE, streamId: 1, code: 1000, reason: "eof" })),
    );
    expect(f.hub.hasActiveRelay(f.id)).toBe(false);
    idleNow += 60_000;
    await idle.reconcileOne(new AbortController().signal);
    expect(checkpoint).toHaveBeenCalledTimes(1);

    f.hub.websocket.message(
      rt.ws,
      Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.CLOSE, streamId: 0, code: 1001, reason: "eof" })),
    );
    expect([rt.code(), c1.code(), c2.code(), f.hub.isConnected(f.id, rt.active.epoch)]).toEqual([
      1001,
      1012,
      1012,
      false,
    ]);
    const rt2 = await f.connectRuntime(rt.active, true);
    const adminClient = await f.openClient({
      authorization: `Bearer ${await f.mint({ mode: "pty" }, f.admin)}`,
    });
    const ownerClient = await f.openClient({ authorization: `Bearer ${await f.mint({ mode: "pty" })}` });
    await f.db.query("update members set role='admin' where user_id=$1", [f.ownerId]);
    await f.db.query("update members set role='member' where user_id=$1", [f.admin.userId]);
    await f.timer.advance(30_000);
    expect(await adminClient.closed).toBe(4401);
    expect(ownerClient.code()).toBeUndefined();
    expect(
      ownerClient.frames.some((b) => b instanceof Uint8Array && decodeRelayMessage(b).type === RELAY_OPCODE.PING),
    ).toBe(true);
    const pingFrame = Buffer.from(encodeRelayMessage({ type: RELAY_OPCODE.PING }));
    const ping1 = f.hub.websocket.message(rt2.ws, pingFrame);
    f.hub.websocket.message(rt2.ws, pingFrame);
    await ping1;
    expect([rt2.code(), ownerClient.code()]).toEqual([1008, 1012]);
    const rt3 = await f.connectRuntime(rt.active, true);
    const ownerClient2 = await f.openClient({ authorization: `Bearer ${await f.mint({ mode: "pty" })}` });
    await f.db.query("update sandboxes set application_secret_tainted=true where id=$1", [f.id]);
    await f.timer.advance(20_000);
    expect([await rt3.closed, await ownerClient2.closed]).toEqual([4403, 4403]);
  } finally {
    await f.hub.stop();
  }
});
