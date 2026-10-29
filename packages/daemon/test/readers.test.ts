import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { serverMessageSchema, PROTOCOL_VERSION as version } from "@armada/protocol";
import { WebSocket } from "ws";
import { fold } from "../src/fold.ts";
import { startServer } from "../src/server/index.ts";
import { daemonProjectSchema, startReaders } from "../src/server/readers.ts";
import { EventStore } from "../src/store.ts";
import { readerRegistry } from "./support/reader-plugins.ts";

import { github, issue, page, project } from "./support/reader-recordings.ts";

function clock() {
  const tasks = new Map<() => void, number>();
  return {
    tasks,
    schedule(callback: () => void, delay: number) {
      tasks.set(callback, delay);
      return () => {
        tasks.delete(callback);
      };
    },
    tick() {
      const scheduled = [...tasks.keys()];
      assert.equal(scheduled.length, 2, "both independent next polls are scheduled");
      for (const callback of scheduled) {
        tasks.delete(callback);
        callback();
      }
    },
  };
}

test("daemon readers commit recorded Linear/GitHub facts to the subscribed store and stop active reads", {
  timeout: 5000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-readers-"));
  const store = new EventStore(join(dir, "fleet.sqlite"));
  const server = await startServer({ store, projects: [project] });
  const ws = new WebSocket(server.wsUrl);
  const received: unknown[] = [];
  ws.on("message", (data) => received.push(serverMessageSchema.parse(JSON.parse(String(data)))));
  t.after(async () => {
    ws.terminate();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await once(ws, "open");
  const subscribed = once(ws, "message");
  ws.send(JSON.stringify({ version, id: "subscribe", type: "project.subscribe", project: project.id, after: 0 }));
  await subscribed;
  const timer = clock();
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {
    Root: [{ issue: issue("SEED-1") }],
    Children: [{ issues: page([issue("SEED-2", "implementing")]) }, { issues: page([]) }],
    Comments: [{ issues: { nodes: ["SEED-1", "SEED-2"].map((identifier) => ({ identifier, comments: page([]) })) } }],
    Pulls: [github],
  };
  const signals: AbortSignal[] = [];
  const release: (() => void)[] = [];
  let bothEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  let trackerSeen: () => void = () => {};
  const trackerReady = new Promise<void>((resolve) => {
    trackerSeen = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(() => {
      const events = store.readSince(0);
      if (events.some((event) => event.kind === "ticket.seen" && event.payload.id === "SEED-2")) trackerSeen();
      if (events.some((e) => e.kind === "ticket.seen") && events.some((e) => e.kind === "pull-request.opened")) {
        unsubscribe();
        resolve();
      }
    });
  });
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /query\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push(operation);
    if (operation === "Root") assert.equal(variables.id, "SEED-1");
    if (operation === "Pulls") assert.deepEqual([variables.owner, variables.name], ["example", "orchard"]);
    const data = bodies[operation]?.shift();
    if (data) return Response.json({ data });
    assert.ok(operation === "Changed" || operation === "Pulls", `unexpected ${operation}`);
    assert.ok(init?.signal);
    signals.push(init.signal);
    if (signals.length === 2) bothEntered();
    return new Promise<Response>((resolve) => release.push(() => resolve(Response.json({ data: github }))));
  });
  const readers = await startReaders({
    registry: await readerRegistry(store, [project], {
      get: async (name) => {
        if (name === "GITHUB_TOKEN") await trackerReady;
        return "synthetic-key";
      },
    }),
    projects: [project],
    schedule: timer.schedule,
    log: (line) => assert.fail(line),
  });
  t.after(() => readers.stop());
  assert.deepEqual(readers.readers, [{ project: "orchard", tracker: true, forge: true }]);
  await committed;
  await setImmediate(); // drain settled readers and loopback delivery, without a wall-clock wait
  const state = fold(store.readSince(0)).projects.orchard;
  assert.equal(state?.sessionsByState["in-progress"][0]?.ticket, "SEED-2");
  assert.equal(state?.pullRequests[0]?.number, 41);
  assert.equal(state?.pullRequests[0]?.ticket, "SEED-2", "forge sees tickets ingested after boot began");
  // A protocol round trip is the delivery barrier for all earlier committed batches.
  const barrier = new Promise<void>((resolve) => {
    const onMessage = (data: unknown) => {
      const message = serverMessageSchema.parse(JSON.parse(String(data)));
      if (message.type === "projects.result" && message.id === "barrier") {
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
  ws.send(JSON.stringify({ version, id: "barrier", type: "projects.list" }));
  await barrier;
  const delivered = received.flatMap((frame) => {
    const message = serverMessageSchema.parse(frame);
    return message.type === "events" ? message.events : [];
  });
  assert.deepEqual(delivered, store.readSince(0));
  assert.ok(calls.includes("Comments") && calls.includes("Pulls"));
  timer.tick();
  await entered;
  assert.ok(signals.every((signal) => !signal.aborted));
  const cursor = store.sequence;
  readers.stop();
  readers.stop();
  assert.ok(signals.every((signal) => signal.aborted));
  for (const settle of release) settle();
  await setImmediate();
  assert.equal(timer.tasks.size, 0);
  assert.equal(store.sequence, cursor, "late provider results cannot append after shutdown");
});

test("disabled providers never start a read; cancellation before startup leaves no timers", async () => {
  const timer = clock();
  const { PluginRegistry } = await import("../src/plugins/registry.ts");
  const registry = new PluginRegistry();
  const readers = await startReaders({ registry, projects: [project], schedule: timer.schedule });
  assert.deepEqual(readers.readers, [{ project: project.id, tracker: false, forge: false }]);
  assert.equal(timer.tasks.size, 0);
  readers.stop();
});

test("reader catalog validates optional roots and phase groups before boot", () => {
  assert.equal(daemonProjectSchema.parse(project).phaseGroup, "Agent phase");
  assert.equal(daemonProjectSchema.parse({ ...project, phaseGroup: "Fleet phase" }).phaseGroup, "Fleet phase");
  assert.equal(daemonProjectSchema.safeParse({ ...project, programRoot: "" }).success, false);
  assert.equal(daemonProjectSchema.safeParse({ ...project, phaseGroup: 42 }).success, false);
});

test("shutdown clears the deadline even when a registry provider ignores cancellation", async () => {
  const { PluginRegistry } = await import("../src/plugins/registry.ts");
  const registry = new PluginRegistry();
  const activation = registry.activation({
    id: "fixture",
    version: "1.0.0",
    pluginApi: "^0.1.0",
    enabledByDefault: true,
    description: "Uncooperative fixture",
    contributions: { tracker: { linear: { config: true, secrets: [] } } },
  });
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  activation.register.tracker("linear", {
    read: async (request) => {
      signal = request.signal;
      entered();
      await pending;
    },
    write: async () => {},
  });
  activation.commit();
  const timer = clock();
  const readers = await startReaders({ registry, projects: [project], schedule: timer.schedule });
  await ready;
  assert.equal(timer.tasks.size, 1, "the active read has a deadline");
  try {
    readers.stop();
    assert.equal(signal?.aborted, true);
    assert.equal(timer.tasks.size, 0, "shutdown releases the deadline without waiting for the provider");
  } finally {
    release();
  }
  await setImmediate();
  assert.equal(timer.tasks.size, 0);
});
