import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type ProtocolEvent,
  type ServerMessage,
  serverMessageSchema,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { WebSocket } from "ws";
import { startServer } from "../src/server/index.ts";
import { startReaders } from "../src/server/readers.ts";
import { EventStore } from "../src/store.ts";
import { readerRegistry } from "./support/reader-plugins.ts";
import { github, issue, page, project } from "./support/reader-recordings.ts";

// Promise gates control provider progress; no real network or polling delays.
function gate() {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

describe("reader/WebSocket composition", { timeout: 4000 }, () => {
  let store: EventStore;
  let server: Awaited<ReturnType<typeof startServer>>;
  let ws: WebSocket;
  let readers: Awaited<ReturnType<typeof startReaders>> | undefined;
  const linear = gate();
  const forge = gate();
  const frames: unknown[] = [];
  let wake: (() => void) | undefined;
  const next = async (): Promise<ServerMessage> => {
    if (!frames.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    return serverMessageSchema.parse(frames.shift());
  };

  const eventsUntil = async (seen: (event: ProtocolEvent) => boolean) => {
    const events: ProtocolEvent[] = [];
    do {
      const frame = await next();
      assert.equal(frame.type, "events");
      if (frame.type !== "events") throw new Error("Expected reader events");
      events.push(...frame.events);
    } while (!events.some(seen));
    return events;
  };

  before(
    async () => {
      store = new EventStore(":memory:");
      server = await startServer({ store, projects: [project] });
      ws = new WebSocket(server.wsUrl);
      ws.on("message", (data) => {
        frames.push(JSON.parse(String(data)));
        wake?.();
      });
      await once(ws, "open");
    },
    { timeout: 1000 },
  );

  after(
    async () => {
      readers?.stop();
      linear.release();
      forge.release();
      await setImmediate(); // settle any aborted provider read before closing its store
      ws?.terminate();
      await server?.close();
      store?.close();
    },
    { timeout: 1000 },
  );

  test("hanging Linear reads leave subscription, replay and both readers' live delivery responsive", {
    timeout: 2000,
  }, async (t) => {
    const entered = gate();
    let requestSignal: AbortSignal | undefined;
    let linearReturned = false;
    const bodies: Record<string, unknown[]> = {
      Root: [{ issue: issue("SEED-1") }],
      Children: [{ issues: page([issue("SEED-2", "implementing")]) }, { issues: page([]) }],
      Comments: [{ issues: { nodes: ["SEED-1", "SEED-2"].map((identifier) => ({ identifier, comments: page([]) })) } }],
      Pulls: [github],
    };
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      const operation = /query\s+(\w+)/.exec(query)?.[1] ?? "?";
      const data = bodies[operation]?.shift();
      assert.ok(data, `unexpected ${operation}`);
      if (operation === "Root") {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        entered.release();
        await linear.pending;
        linearReturned = true;
      } else if (operation === "Pulls") await forge.pending;
      return Response.json({ data });
    });
    readers = await startReaders({
      registry: await readerRegistry(store, [project]),
      projects: [project],
      schedule: () => () => {},
      log: (line) => assert.fail(line),
    });
    await entered.pending;
    assert.equal(requestSignal?.aborted, false);
    const subscribe = () =>
      ws.send(JSON.stringify({ version, id: "subscribe", type: "project.subscribe", project: project.id, after: 0 }));
    subscribe();
    assert.equal((await next()).type, "project.subscribed");
    const empty = await next();
    assert.equal(empty.type, "events");
    if (empty.type !== "events") throw new Error("Expected replay");
    assert.deepEqual(empty.events, []);

    forge.release();
    const liveForge = await eventsUntil((event) => event.kind === "pull-request.opened");
    assert.equal(linearReturned, false, "forge events arrive while Linear is still pending");

    subscribe();
    assert.equal((await next()).type, "project.subscribed");
    const replay = await next();
    assert.equal(replay.type, "events");
    if (replay.type !== "events") throw new Error("Expected replay during pending Linear read");
    assert.deepEqual(replay.events, liveForge);
    assert.equal(linearReturned, false);
    assert.equal(requestSignal?.aborted, false);

    linear.release();
    const liveTracker = await eventsUntil(
      (event) =>
        event.kind === "coordinator.checkpoint" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "checkpoint" in event.payload &&
        typeof event.payload.checkpoint === "object" &&
        event.payload.checkpoint !== null &&
        "format" in event.payload.checkpoint &&
        event.payload.checkpoint.format === "armada.linear-reader",
    );
    assert.ok(
      liveTracker.some(
        (event) =>
          event.kind === "ticket.seen" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "id" in event.payload &&
          event.payload.id === "SEED-2",
      ),
    );
    assert.deepEqual([...liveForge, ...liveTracker], store.readSince(0));
  });
});
