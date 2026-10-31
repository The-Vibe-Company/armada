import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";

// Presence is ephemeral owner activity, never an all-project event subscription.
test("room presence follows visible rooms across connections and clears on disconnect", {
  timeout: 5000,
}, async (t) => {
  const store = new EventStore(":memory:");
  const changes: string[] = [];
  const server = await startServer({
    store,
    projects: ["orchard", "garden"].map((id) => ({ id, name: id, repository: `example/${id}` })),
    onRoomPresence: (project) => changes.push(project),
  });
  const first = new WebSocket(server.wsUrl);
  const second = new WebSocket(server.wsUrl);
  t.after(async () => {
    first.terminate();
    second.terminate();
    await server.close();
    store.close();
  });
  await Promise.all([once(first, "open"), once(second, "open")]);
  let next = 0;
  // A projects.list reply is an ordering barrier for a fire-and-forget presence signal.
  async function send(ws: WebSocket, message: object) {
    const id = `barrier-${next++}`;
    const received = new Promise<void>((resolve) => {
      const listener = (data: unknown) => {
        const frame = JSON.parse(String(data));
        if (frame.id === id) {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });
    ws.send(JSON.stringify({ version, id: `presence-${next}`, ...message }));
    ws.send(JSON.stringify({ version, id, type: "projects.list" }));
    await received;
  }
  await send(first, { type: "project.subscribe", project: "orchard", after: 0 });
  assert.equal(server.isRoomVisible("orchard"), false, "a subscription does not mean its room is visible");
  await send(first, { type: "room.presence", project: "orchard" });
  assert.equal(server.isRoomVisible("orchard"), true);
  assert.deepEqual(changes, ["orchard"]);
  await send(second, { type: "room.presence", project: "orchard" });
  await send(first, { type: "room.presence", project: "garden" });
  assert.equal(server.isRoomVisible("orchard"), true, "another connection still views the first room");
  assert.equal(server.isRoomVisible("garden"), true);
  assert.deepEqual(changes, ["orchard", "garden"]);
  await send(first, { type: "room.presence", project: null });
  assert.equal(server.isRoomVisible("garden"), false);
  assert.deepEqual(changes, ["orchard", "garden", "garden"]);
  const closed = once(second, "close");
  second.close();
  await closed;
  // Another socket's round trip observes the completed close handler.
  await send(first, { type: "projects.list" });
  assert.equal(server.isRoomVisible("orchard"), false);
  assert.deepEqual(changes, ["orchard", "garden", "garden", "orchard"]);
  assert.equal(store.sequence, 0, "room visibility never grows the durable log");
});
