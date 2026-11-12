import { expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import type { ServerWebSocket } from "bun";
import { createRuntimeCommands } from "../src/runtime-commands.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeSockets, type RuntimeSocketData } from "../src/runtime-sockets.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

async function fixture() {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status)
    select $1,id,org_id,owner_id,'socket-native','codex','ready' from goldens where owner_id=$2 and visibility='private' limit 1`,
    [id, people.owner],
  );
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY),
    commands = createRuntimeCommands(authority, ENCRYPTION_KEY);
  const enrol = async () =>
    authority.enrol(
      (await authority.issue({ sandboxId: id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
  let now = 0;
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
  async function connect(active: Awaited<ReturnType<typeof enrol>>) {
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
    const fake = {
      data,
      send(value: string) {
        sent.push(JSON.parse(value));
        return Buffer.byteLength(value);
      },
      close(value: number) {
        code = value;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>;
    sockets.websocket.open?.(fake);
    return {
      fake,
      sent,
      code: () => code,
      message: (value: unknown) => sockets.websocket.message(fake, JSON.stringify(value)),
    };
  }
  return { db, people, id, authority, commands, sockets, enrol, request, connect, tick, timers };
}

test("authenticated ready/ping delivers one pending command, and HTTP ACK advances the durable socket head", async () => {
  const f = await fixture();
  try {
    const active = await f.enrol();
    for (const requestId of ["first", "second"])
      await f.commands.enqueue(f.people.owner, { version: 1, sandboxId: f.id, requestId, op: "health" });
    const socket = await f.connect(active);
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
    await f.tick();
    expect(socket.sent.at(-1)).toMatchObject({ type: "command", request: { requestId: "second" } });
    await socket.message({ type: "ping", epoch: active.epoch });
    expect(socket.sent.at(-1)).toEqual({ type: "pong", epoch: active.epoch });
    await f.sockets.stop();
    expect(socket.code()).toBe(1012);
    expect(f.timers.size).toBe(0);
    expect((await f.sockets.upgrade(f.request(active.runtimeToken, active.epoch), () => true))?.status).toBe(503);
  } finally {
    await f.sockets.stop();
    await f.db.close();
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
    await f.tick();
    expect(socket.code()).toBe(4401);
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
    await f.db.close();
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
    await f.db.close();
  }
});
