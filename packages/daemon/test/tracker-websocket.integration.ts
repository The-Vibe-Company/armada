// Opt-in composition test: THE-1987's server ships in parallel with this reader.
// Once both are present: node --test test/tracker-websocket.integration.ts
// Before it lands, ARMADA_TEST_DAEMON_ROOT may name a read-only copy of its src/.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, serverMessageSchema } from "../../protocol/src/index.ts";
import type { EventInput, FleetEvent } from "../src/events.ts";
import { linearTracker } from "../src/tracker/linear/index.ts";
import { TrackerPoller } from "../src/tracker/poll.ts";

interface Store {
  append(event: EventInput): FleetEvent;
  readSince(seq: number, project?: string): FleetEvent[];
  close(): void;
}
const source = process.env.ARMADA_TEST_DAEMON_ROOT
  ? pathToFileURL(`${resolve(process.env.ARMADA_TEST_DAEMON_ROOT)}/`)
  : new URL("../src/", import.meta.url);
const { EventStore } = (await import(new URL("store.ts", source).href)) as {
  EventStore: new (path: string) => Store;
};
const { startServer } = (await import(new URL("server/index.ts", source).href)) as {
  startServer(options: {
    store: Store;
    projects: { id: string; name: string; repository: string }[];
  }): Promise<{ wsUrl: string; close(): Promise<void> }>;
};

test("a hanging Linear fetch leaves real WebSocket subscription, replay and live delivery responsive", {
  timeout: 5000,
}, async (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  const server = await startServer({
    store,
    projects: [{ id: "orchard", name: "Orchard", repository: "example/orchard" }],
  });
  t.after(() => server.close());
  const now = () => new Date("2030-01-01T10:00:00Z");
  let entered: () => void = () => {};
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let requestSignal: AbortSignal | undefined;
  const tracker = linearTracker({
    project: "orchard",
    rootId: "SEED-1",
    phaseGroup: "Fleet phase",
    secrets: async () => "fake-key",
    now,
    fetch: async (_url, init) => {
      assert.ok(init.signal);
      requestSignal = init.signal;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const poller = new TrackerPoller({ project: "orchard", tracker, store, clock: { now, set: () => () => {} } });
  poller.start();
  const reading = poller.readNow();
  t.after(async () => {
    poller.stop();
    await reading;
  });
  await fetching; // the actual injected Linear fetch is now pending, with a live signal
  assert.equal(requestSignal?.aborted, false);
  assert.equal(poller.status.reading, true);

  const ws = new WebSocket(server.wsUrl);
  t.after(() => ws.close());
  const frames: unknown[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
    wake?.();
  });
  const next = async () => {
    if (!frames.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    return serverMessageSchema.parse(frames.shift());
  };
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      id: "subscribe",
      type: "project.subscribe",
      project: "orchard",
      after: 0,
    }),
  );
  assert.equal((await next()).type, "project.subscribed");
  const replay = await next();
  assert.equal(replay.type, "events");
  if (replay.type !== "events") throw new Error("Expected replay");
  assert.deepEqual(replay.events, []);
  const committed = store.append({
    project: "orchard",
    kind: "hold.opened",
    at: now().toISOString(),
    actor: "Mira",
    payload: { id: "shade", reason: "Wait for shade" },
  });
  const live = await next();
  assert.equal(live.type, "events");
  if (live.type !== "events") throw new Error("Expected live events");
  assert.deepEqual(live.events, [committed]);
  assert.equal(poller.status.lastCompletedAt, null);
  assert.equal(poller.status.reading, true);
  assert.equal(requestSignal?.aborted, false);
});
