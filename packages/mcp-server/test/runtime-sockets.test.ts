import { expect, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import type { ServerWebSocket } from "bun";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments, scopedRuntimeSql } from "../src/runtime-enrolment.ts";
import { createRuntimeSockets, type RuntimeSocketData } from "../src/runtime-sockets.ts";
import { sqlOver } from "../src/sql.ts";
import { runtimeWakes } from "../src/wake-bus.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

async function fixture(wait?: (ms: number) => Promise<void>) {
  const { db, people } = await sharedDatabase();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'socket-native','codex','ready' from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  const sql = sqlOver({
    unsafe: async (q, v) => (await db.query(q, v)).rows,
    begin: (work) => db.transaction((tx) => work({ unsafe: async (q, v) => (await tx.query(q, v)).rows })),
  });
  let now = 0;
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY),
    commands = createRuntimeCommands(authority, ENCRYPTION_KEY, wait && { now: () => now, wait });
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ sandboxId: id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
  const timers = new Set<() => void>();
  const sockets = createRuntimeSockets(authority, commands, {
    now: () => now,
    every(ms, callback) {
      expect(ms).toBe(1000);
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  const tick = async (ms = 1000) => {
    now += ms;
    for (const callback of [...timers]) await callback();
  };
  const request = (token: string, epoch: string) =>
    new Request("https://armada.example/api/runtime/channel", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "x-armada-runtime-epoch": epoch },
    });
  async function connect(active: Awaited<ReturnType<typeof enrol>>, onCommand?: (id: string) => void) {
    let data: RuntimeSocketData | undefined;
    expect(
      await sockets.upgrade(request(active.runtimeToken, active.epoch), (value) => {
        data = value;
        return true;
      }),
    ).toBeUndefined();
    if (!data) throw Error("missing upgrade data");
    const sent: { type: string; epoch: string; request?: { requestId: string } }[] = [];
    let code: number | undefined;
    const closed = Promise.withResolvers<number>();
    const fake = {
      data,
      send(value: string) {
        const frame = JSON.parse(value);
        sent.push(frame);
        if (frame.type === "command") onCommand?.(frame.request.requestId);
        return Buffer.byteLength(value);
      },
      close(value: number) {
        code = value;
        closed.resolve(value);
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    sockets.websocket.open?.(fake);
    return {
      fake,
      sent,
      code: () => code,
      closed: closed.promise,
      message: (value: unknown) => sockets.websocket.message(fake, JSON.stringify(value)),
    };
  }
  return { db, sql, people, id, authority, commands, sockets, enrol, request, connect, tick, timers };
}

test("authenticated ready/ping delivers one pending command, and HTTP ACK advances the durable socket head", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    for (const requestId of ["first", "second"])
      await f.commands.enqueue(f.people.owner, { version: 1, sandboxId: f.id, requestId, op: "health" });
    const second = Promise.withResolvers<void>();
    const socket = await f.connect(active, (id) => {
      if (id === "second") second.resolve();
    });
    expect(socket.sent).toHaveLength(0);
    await socket.message({ type: "ready", epoch: active.epoch });
    expect(socket.sent).toMatchObject([{ type: "command", epoch: active.epoch, request: { requestId: "first" } }]);
    await f.tick();
    await f.tick();
    expect(socket.sent).toHaveLength(1); // Do not queue copies while native RPC is running.
    await f.commands.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: "first",
      status: 200,
      body: {},
    });
    await second.promise;
    expect(socket.sent.at(-1)).toMatchObject({ type: "command", request: { requestId: "second" } });
    await socket.message({ type: "ping", epoch: active.epoch });
    expect(socket.sent.at(-1)).toEqual({ type: "pong", epoch: active.epoch });
    await f.sockets.stop();
    expect(socket.code()).toBe(1012);
    expect(f.timers.size).toBe(0);
    expect((await f.sockets.upgrade(f.request(active.runtimeToken, active.epoch), () => true))?.status).toBe(503);
  } finally {
    await f.sockets.stop();
  }
});

test("replaced epoch fences idle and busy sockets before delivering another command or heartbeat", async () => {
  const f = await fixture();
  try {
    const old = await f.enrol(),
      socket = await f.connect(old);
    await socket.message({ type: "ready", epoch: old.epoch });
    const current = await f.enrol();
    await f.commands.enqueue(f.people.owner, { version: 1, sandboxId: f.id, requestId: "new-epoch", op: "health" });
    expect(await socket.closed).toBe(4401);
    expect(socket.sent).toHaveLength(0);
    expect((await f.sockets.upgrade(f.request(old.runtimeToken, old.epoch), () => true))?.status).toBe(401);
    const fresh = await f.connect(current);
    await fresh.message({ type: "ready", epoch: current.epoch });
    expect(fresh.sent).toHaveLength(1);
    await fresh.message({ type: "ping", epoch: old.epoch });
    expect(fresh.code()).toBe(4401);
    expect(fresh.sent).toHaveLength(1);
  } finally {
    await f.sockets.stop();
  }
});

test("control frame bounds, ready/idle deadlines and malformed upgrades cannot leak or grow delivery queues", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    expect(
      (await f.sockets.upgrade(new Request("https://armada.example/api/runtime/channel"), () => true))?.status,
    ).toBe(426);
    expect((await f.sockets.upgrade(f.request("invalid", active.epoch), () => true))?.status).toBe(401);
    expect((await f.sockets.upgrade(f.request(active.runtimeToken, active.epoch), () => false))?.status).toBe(400);
    const missingReady = await f.connect(active);
    await f.tick(8000);
    expect(missingReady.code()).toBe(1002);
    const idle = await f.connect(active);
    await idle.message({ type: "ready", epoch: active.epoch });
    await f.tick(30000);
    expect(idle.code()).toBe(1001);
    for (const frame of [
      { type: "ping", epoch: active.epoch },
      { type: "ready", epoch: active.epoch, extra: true },
      { type: "results", epoch: active.epoch },
    ]) {
      const socket = await f.connect(active);
      await socket.message(frame);
      expect(socket.code()).toBe(1002);
      expect(socket.sent).toHaveLength(0);
    }
    const binary = await f.connect(active);
    await f.sockets.websocket.message(binary.fake, Buffer.from("{}"));
    expect(binary.code()).toBe(1002);
    const large = await f.connect(active);
    await f.sockets.websocket.message(large.fake, "x".repeat(1025));
    expect(large.code()).toBe(1002);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.sockets.stop();
  }
});

test("local enqueue and result reach an idle socket and reply waiter with frozen clocks", async () => {
  const sleeping = Promise.withResolvers<number>();
  const f = await fixture((ms) => {
    sleeping.resolve(ms);
    return new Promise<void>(() => {});
  });
  const abort = new AbortController();
  try {
    const active = await f.enrol();
    const sent = Promise.withResolvers<string>();
    const socket = await f.connect(active, sent.resolve);
    await socket.message({ type: "ready", epoch: active.epoch });
    const request = { version: 1, sandboxId: f.id, requestId: "local", op: "health" } as const;
    const reply = f.commands.call(f.people.owner, request, { signal: abort.signal });
    void reply.catch(() => {});
    expect(await sent.promise).toBe(request.requestId);
    expect(await sleeping.promise).toBe(250);
    await f.commands.complete(active.runtimeToken, active.epoch, {
      epoch: active.epoch,
      requestId: request.requestId,
      status: 200,
      body: {},
    });
    expect(await reply).toMatchObject({ requestId: request.requestId, status: 200 });
  } finally {
    abort.abort();
    await f.sockets.stop();
  }
});

test("transaction-scoped enqueue wakes the socket on outer commit", async () => {
  const f = await fixture();
  let wakes = 0;
  const unsubscribe = runtimeWakes.subscribe(`socket:${f.id}`, () => wakes++);
  try {
    const active = await f.enrol();
    const sent = Promise.withResolvers<string>();
    const socket = await f.connect(active, sent.resolve);
    await socket.message({ type: "ready", epoch: active.epoch });
    const enqueue = (requestId: string, rollback = false) =>
      f.sql.transaction!(async (tx) => {
        const scoped = createRuntimeCommands(
          createRuntimeEnrolments(scopedRuntimeSql(tx), ENCRYPTION_KEY),
          ENCRYPTION_KEY,
        );
        await scoped.enqueue(f.people.owner, { version: 1, sandboxId: f.id, requestId, op: "health" });
        expect(wakes).toBe(0);
        if (rollback) throw Error("rollback");
      });
    await expect(enqueue("rolled-back", true)).rejects.toThrow("rollback");
    expect(wakes).toBe(0);
    await enqueue("nested");
    expect(wakes).toBe(1);
    expect(await sent.promise).toBe("nested");
  } finally {
    unsubscribe();
    await f.sockets.stop();
  }
});

test("socket and reply polls deliver writes from another process without wakes", async () => {
  const sleeping = Promise.withResolvers<number>();
  const tickReply = Promise.withResolvers<void>();
  const f = await fixture((ms) => {
    sleeping.resolve(ms);
    return tickReply.promise;
  });
  const abort = new AbortController();
  try {
    const active = await f.enrol();
    const socket = await f.connect(active);
    await socket.message({ type: "ready", epoch: active.epoch });
    const request = { version: 1, sandboxId: f.id, requestId: "remote", op: "health" } as const;
    const sealed = await encryptSecret(JSON.stringify(request), ENCRYPTION_KEY);
    await f.db.query("insert into runtime_commands(sandbox_id,request_id,epoch,request_enc) values($1,$2,$3,$4)", [
      f.id,
      request.requestId,
      active.epoch,
      sealed,
    ]);
    const reply = f.commands.call(f.people.owner, request, { signal: abort.signal });
    void reply.catch(() => {});
    expect(await sleeping.promise).toBe(250);
    expect(socket.sent).toHaveLength(0);
    await f.tick();
    expect(socket.sent).toMatchObject([{ type: "command", request: { requestId: request.requestId } }]);
    const result = { epoch: active.epoch, requestId: request.requestId, status: 200, body: {} };
    await f.db.query("update runtime_commands set result_enc=$1 where sandbox_id=$2 and request_id=$3", [
      await encryptSecret(JSON.stringify(result), ENCRYPTION_KEY),
      f.id,
      request.requestId,
    ]);
    tickReply.resolve();
    expect(await reply).toEqual(result);
  } finally {
    abort.abort();
    await f.sockets.stop();
  }
});
