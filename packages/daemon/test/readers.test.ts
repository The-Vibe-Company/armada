import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

const project = { id: "orchard", name: "Orchard", repository: "example/orchard", programRoot: "SEED-1" };
const now = () => new Date("2030-01-01T10:00:00Z");
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const issue = (id: string, phase?: string) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `Grow ${id}`,
  url: `https://linear.example/issue/${id}`,
  state: { type: phase ? "started" : "backlog" },
  assignee: { name: "Mira" },
  parent: id === "SEED-1" ? null : { identifier: "SEED-1" },
  labels: page(phase ? [{ name: phase, parent: { name: "Agent phase" } }] : []),
  attachments: page([]),
});
const github = {
  repository: {
    open: page([
      {
        number: 41,
        title: "Grow the orchard",
        url: "https://github.com/example/orchard/pull/41",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefName: "feature/seed-2-grow",
        headRefOid: "aaa",
        reviewDecision: "APPROVED",
        commits: {
          nodes: [
            {
              commit: {
                oid: "aaa",
                checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
                statusCheckRollup: null,
              },
            },
          ],
        },
      },
    ]),
  },
};
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
  const readers = await startReaders({
    store,
    projects: [project],
    now,
    schedule: timer.schedule,
    secrets: async () => randomUUID(),
    token: async () => {
      await trackerReady;
      return randomUUID();
    },
    fetch: async (_url, init) => {
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
    },
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

test("a catalog without programRoot starts only the forge; missing credentials skip once per reader", async () => {
  const store = new EventStore(":memory:");
  const timer = clock();
  const lines: string[] = [];
  const credential = randomUUID();
  const meadow = "meadow\n\u001b[31m\u0085\u2028";
  const plain = { id: "harbor", name: "Harbor", repository: "example/harbor" };
  let fetched = 0;
  let lookedUp = 0;
  const readers = await startReaders({
    store,
    projects: [plain, project, { ...project, id: meadow }],
    now,
    schedule: timer.schedule,
    secrets: async () => {
      lookedUp++;
      throw new Error(credential);
    },
    token: async () => {
      if (lookedUp) throw new Error(credential);
      return credential;
    },
    fetch: async () => {
      fetched++;
      return Response.json({ data: { repository: { open: page([]) } } });
    },
    log: (line) => lines.push(line),
  });
  try {
    await setImmediate();
    assert.deepEqual(readers.readers, [
      { project: "harbor", tracker: false, forge: true },
      { project: "orchard", tracker: false, forge: false },
      { project: meadow, tracker: false, forge: false },
    ]);
    assert.equal(lookedUp, 2, "no Linear lookup for a project without a root");
    assert.equal(fetched, 1, "skipped readers never fetch");
    assert.deepEqual(lines, [
      "armadad: orchard: tracker skipped (Linear key unavailable)",
      "armadad: orchard: forge skipped (GitHub key unavailable)",
      "armadad: meadow\\u000a\\u001b[31m\\u0085\\u2028: tracker skipped (Linear key unavailable)",
      "armadad: meadow\\u000a\\u001b[31m\\u0085\\u2028: forge skipped (GitHub key unavailable)",
    ]);
    assert.equal(lines.join().includes(credential), false);
  } finally {
    readers.stop();
    await setImmediate();
    store.close();
  }
});

test("reader catalog validates optional roots and phase groups before boot", () => {
  assert.equal(daemonProjectSchema.parse(project).phaseGroup, "Agent phase");
  assert.equal(daemonProjectSchema.parse({ ...project, phaseGroup: "Fleet phase" }).phaseGroup, "Fleet phase");
  assert.equal(daemonProjectSchema.safeParse({ ...project, programRoot: "" }).success, false);
  assert.equal(daemonProjectSchema.safeParse({ ...project, phaseGroup: 42 }).success, false);
});

test("shutdown during credential preflight cannot start readers against a closed store", async () => {
  for (const stage of ["tracker", "forge"]) {
    const store = new EventStore(":memory:");
    const controller = new AbortController();
    let release: (key: string) => void = () => {};
    const key = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = startReaders({
      store,
      projects: [{ ...project, programRoot: stage === "tracker" ? project.programRoot : undefined }],
      signal: controller.signal,
      secrets: () => key,
      token: () => key,
      fetch: async () => {
        assert.fail("shutdown must prevent provider fetches");
      },
      log: (line) => assert.fail(line),
    });
    controller.abort();
    store.close();
    release(randomUUID());
    const readers = await pending;
    assert.deepEqual(readers.readers, [{ project: "orchard", tracker: false, forge: false }]);
    readers.stop();
  }
});
