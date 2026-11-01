import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import {
  type InboxRequest,
  type ProjectTables,
  type ServerMessage,
  serverMessageSchema,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import { WebSocket } from "ws";
import type { EventInput, FleetEvent } from "../src/events.ts";
import { fold } from "../src/fold.ts";
import { Keychain } from "../src/keychain.ts";
import { startServer } from "../src/server/index.ts";
import { Replay } from "../src/server/replay.ts";
import { EventStore } from "../src/store.ts";
import { FakeKeychain } from "./support/keychain.ts";
import { nodeExecutable } from "./support/node.ts";

const projects = [
  { id: "orchard", name: "Orchard", repository: "example/orchard" },
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
];
const hold = (project = "orchard", id = "rain"): EventInput => ({
  project,
  kind: "hold.opened",
  at: "2030-01-01T10:00:00Z",
  actor: "Mira",
  payload: { id, reason: "Wait for CI" },
});

/** A project's folded tables holding only these open holds, as the protocol carries them. */
const holding = (...events: FleetEvent[]) => ({
  rules: { revision: 0, value: {} },
  tickets: [],
  pullRequests: [],
  sessions: [],
  sessionsByState: {
    blocked: [],
    "waiting-for-owner": [],
    "in-progress": [],
    "ready-to-merge": [],
    merged: [],
    released: [],
  },
  inbox: [],
  queue: [],
  holds: events.map((e) => ({ ...(e.payload as { id: string; reason: string }), at: e.at, actor: e.actor })),
  validations: [],
});

// Queue frames immediately, including replies that arrive together. No sleeps or polling.
async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    frames.push(String(data));
    wake?.();
  });
  await once(ws, "open");
  async function nextRaw(): Promise<string> {
    if (!frames.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    return frames.shift() as string;
  }
  return {
    ws,
    nextRaw,
    send: (body: Record<string, unknown>) => ws.send(JSON.stringify({ version, id: "r1", ...body })),
    async next(): Promise<ServerMessage> {
      return serverMessageSchema.parse(JSON.parse(await nextRaw()));
    },
  };
}

test("armadad starts beside a crashed socket, announces its address and quits cleanly on SIGTERM", {
  timeout: 10000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-process-"));
  const catalog = join(dir, "projects.json");
  mkdirSync(join(dir, "data"));
  const stalePath = join(dir, "data", "worker.sock");
  const stale = spawn(
    nodeExecutable,
    [
      "--input-type=module",
      "-e",
      "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => console.log('bound'));",
      stalePath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await once(stale.stdout, "data");
  const crashed = once(stale, "exit");
  stale.kill("SIGKILL");
  await crashed;
  assert.equal(lstatSync(stalePath).isSocket(), true);
  // Boot the same durable conversations regardless of the parent terminal's model settings.
  writeFileSync(
    catalog,
    JSON.stringify(
      projects.map((project) => ({
        ...project,
        programRoot: "SEED-1",
        coordinatorModel: {
          kind: "openai-compatible",
          config: { model: "offline-startup", baseURL: "http://fixture.invalid/v1", apiKeySecret: null },
        },
      })),
    ),
  );
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      plugins: [
        {
          id: "linear",
          config: {
            tracker: {
              linear: { projects: Object.fromEntries(projects.map((p) => [p.id, { programRoot: "SEED-1" }])) },
            },
          },
        },
        {
          id: "github",
          config: {
            forge: {
              github: { projects: Object.fromEntries(projects.map((p) => [p.id, { repository: p.repository }])) },
            },
          },
        },
      ],
    }),
  );
  // Native Node preload keeps real boot offline, with active, abortable provider reads.
  const preload = `globalThis.fetch = async (_url, init) => {
    process.stderr.write("armada-test-reader-started\\n");
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("aborted"));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
    });
  };`;
  const child = spawn(
    nodeExecutable,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      new URL("../src/server/main.ts", import.meta.url).pathname,
      "--database",
      join(dir, "data", "fleet.sqlite"),
      "--projects",
      catalog,
      "--static-dir",
      join(dir, "missing"),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ARMADA_APP_CONFIG: join(dir, "config.json"),
        XDG_CONFIG_HOME: dir,

        ARMADA_KEYCHAIN: "file",
        LINEAR_API_KEY: randomBytes(24).toString("hex"),
        GITHUB_TOKEN: randomBytes(24).toString("hex"),
      },
    },
  );
  const exited = once(child, "exit");
  const errors = createInterface({ input: child.stderr });
  const readersActive = new Promise<void>((resolve) => {
    let fetching = 0;
    errors.on("line", (line) => {
      if (line === "armada-test-reader-started" && ++fetching === projects.length * 2) resolve();
    });
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    errors.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const [ready] = await Promise.race([
    once(lines, "line"),
    exited.then(() => {
      throw new Error("daemon exited before readiness");
    }),
  ]);
  lines.close();
  const address = JSON.parse(ready);
  assert.equal(lstatSync(stalePath).isSocket(), true, "startup never deletes another instance socket");
  assert.deepEqual(
    address.readers,
    projects.map((project) => ({
      project: project.id,
      tracker: false,
      forge: false,
      trackerError: "First read pending",
      forgeError: "First read pending",
    })),
  );
  await readersActive;
  assert.equal((await fetch(address.url)).status, 404);
  const client = await connect(address.wsUrl);
  client.send({ type: "projects.list" });
  assert.deepEqual(await client.next(), { type: "projects.result", version, id: "r1", projects });
  const closed = once(client.ws, "close");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await closed;
  const reopened = new EventStore(join(dir, "data", "fleet.sqlite"));
  try {
    const events = reopened.readSince(0);
    // Configured coordinators persist pi's initial documents and may announce their model at boot.
    // Blocked provider reads supply no fleet changes: no wake or model turn is warranted.
    assert.deepEqual([...new Set(events.map((event) => event.project))].sort(), projects.map((p) => p.id).sort());
    assert.ok(
      events.every(
        (event) =>
          (event.kind === "coordinator.checkpoint" &&
            (event.payload.checkpoint as { format?: unknown }).format === "armada.pi") ||
          (event.kind === "coordinator.message" &&
            event.actor === "coordinator" &&
            event.payload.role === "coordinator" &&
            event.payload.body === "Coordinator uses openai-compatible/offline-startup."),
      ),
    );
  } finally {
    reopened.close();
  }
});

test("initial replay waits for its own buffer to drain, preserving replies and cancellation", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const sent: ServerMessage[] = [];
  const closes: [number, string][] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string, callback: (error?: Error) => void) {
      sent.push(JSON.parse(data));
      if (sent.length === 1) this.bufferedAmount = 9 * 1024 * 1024;
      callback();
    },
    close(code: number, reason: string) {
      closes.push([code, reason]);
    },
  };
  const replay = new Replay(socket);
  t.after(() => replay.close());
  const frame = (id: string): ServerMessage => ({ type: "projects.result", version, id, projects });
  let completed = false;
  replay.replay([frame("first"), frame("second")], () => {
    completed = true;
  });
  replay.send(frame("reply"));
  assert.deepEqual(
    sent.map((frame) => "id" in frame && frame.id),
    ["first"],
  );
  t.mock.timers.tick(1000);
  assert.deepEqual(closes, []);
  assert.equal(completed, false);
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  assert.deepEqual(
    sent.map((frame) => "id" in frame && frame.id),
    ["first", "second", "reply"],
  );
  assert.equal(completed, true);

  socket.bufferedAmount = 9 * 1024 * 1024;
  const cancel = replay.replay([frame("obsolete")], () => assert.fail("cancelled replay completed"));
  cancel();
  replay.replay([frame("replacement")], () => {});
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  const last = sent.at(-1);
  assert(last && "id" in last);
  assert.equal(last.id, "replacement");
  assert(!sent.some((frame) => "id" in frame && frame.id === "obsolete"));
  assert.deepEqual(closes, []);
  socket.bufferedAmount = 512 * 1024;
  let acknowledged = false;
  replay.send(frame("restart-ack"), () => {
    acknowledged = true;
  });
  t.mock.timers.tick(1000);
  assert.equal(acknowledged, false, "ordinary replies also wait below low water");
  assert(!sent.some((frame) => "id" in frame && frame.id === "restart-ack"));
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  assert.equal(acknowledged, true, "restart may proceed only after its FIFO acknowledgment drains");
  assert.deepEqual(closes, []);
});

test("a replay drain deadline and a steady slow client close with a code and reason", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const closes: [number, string][] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 9 * 1024 * 1024,
    send() {
      assert.fail("must wait for drain");
    },
    close(code: number, reason: string) {
      closes.push([code, reason]);
    },
  };
  const replay = new Replay(socket);
  t.after(() => replay.close());
  const frame: ServerMessage = { type: "projects.result", version, id: "reply", projects };
  replay.replay([frame], () => assert.fail("undrained replay completed"));
  replay.send(frame);
  assert.deepEqual(closes, []);
  t.mock.timers.tick(10000);
  assert.deepEqual(closes, [[4008, "Replay drain timed out"]]);
  // The ordinary 8 MiB guard still applies without an initial transfer.
  const steady = new Replay(socket);
  steady.send(frame);
  assert.deepEqual(closes.at(-1), [4008, "Client could not drain daemon updates"]);
});

test("a large log starts from its snapshot and recent replay pages omit checkpoint bodies", {
  timeout: 15000,
}, async (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  const inputs = JSON.parse(readFileSync(new URL("./support/protocol-subscription.json", import.meta.url), "utf8")) as {
    history: EventInput[];
  };
  const checkpoint = inputs.history.find((event) => event.kind === "coordinator.checkpoint");
  const ticket = inputs.history.find((event) => event.kind === "ticket.seen");
  const pr = inputs.history.find((event) => event.kind === "pull-request.seen");
  assert(checkpoint && ticket && pr);
  const log: FleetEvent[] = [];
  for (let i = 0; i < 5200; i++) {
    const input =
      i % 5 < 3
        ? { ...checkpoint, payload: { checkpoint: { format: "synthetic", body: "c".repeat(2300) } } }
        : i % 5 === 3
          ? { ...ticket, payload: { ...ticket.payload, title: "Tree 🌳".repeat(400) } }
          : { ...pr, payload: { ...pr.payload, title: "Branches 🌳".repeat(300) } };
    log.push(store.append(input as EventInput));
  }
  assert(Buffer.byteLength(JSON.stringify(log)) >= 12 * 1024 * 1024);
  const expected = JSON.parse(JSON.stringify(fold(log).projects.orchard));
  const server = await startServer({ store, projects });
  t.after(() => server.close());
  const fresh = await connect(server.wsUrl);
  fresh.send({ type: "project.subscribe", project: "orchard", after: 0 });
  const initial = await fresh.next();
  assert.equal(initial.type, "project.subscribed");
  assert("snapshot" in initial && initial.snapshot);
  assert.deepEqual(initial.snapshot.state, expected);
  const empty = await fresh.next();
  assert.equal(empty.type, "events");
  assert("events" in empty);
  assert.equal(empty.events.length, 0, "fresh clients must not replay history");
  assert.equal(empty.seq, store.sequence);
  fresh.send({ type: "projects.list", id: "still-live" });
  assert.equal((await fresh.next()).type, "projects.result");

  const stale = await connect(server.wsUrl);
  stale.send({ type: "project.subscribe", project: "orchard", after: 1 });
  const reset = await stale.next();
  assert("snapshot" in reset && reset.snapshot);
  assert.deepEqual(reset.snapshot.state, expected);
  const resetBatch = await stale.next();
  assert("events" in resetBatch);
  assert.deepEqual(resetBatch.events, []);

  const recent = await connect(server.wsUrl);
  const after = (log[4199] as FleetEvent).seq;
  const replayEnd = store.sequence;
  let concurrent: FleetEvent | undefined;
  recent.send({ type: "project.subscribe", project: "orchard", after });
  assert.equal((await recent.next()).type, "project.subscribed");
  let cursor = after;
  let pages = 0;
  const replay: FleetEvent[] = [];
  for (;;) {
    const raw = await recent.nextRaw();
    assert(Buffer.byteLength(raw) <= 1024 * 1024);
    const frame = serverMessageSchema.parse(JSON.parse(raw));
    assert.equal(frame.type, "events");
    if (frame.type !== "events") throw new Error("Expected replay");
    pages++;
    if (pages === 1) concurrent = store.append(hold("orchard", "during-replay"));
    assert(frame.seq >= cursor);
    for (const event of frame.events) {
      assert(event.seq > cursor);
      if (event.kind === "coordinator.checkpoint") assert.deepEqual(event.payload, { checkpoint: null });
      cursor = event.seq;
      replay.push(event as FleetEvent);
    }
    cursor = frame.seq;
    if (!JSON.parse(raw).more) {
      assert.deepEqual(frame.snapshot?.state, expected);
      break;
    }
  }
  assert(pages > 1);
  assert.equal(cursor, replayEnd);
  assert.deepEqual(
    replay,
    log
      .filter((event) => event.seq > after)
      .map((event) => (event.kind === "coordinator.checkpoint" ? { ...event, payload: { checkpoint: null } } : event)),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fold([...log.filter((event) => event.seq <= after), ...replay]).projects.orchard)),
    expected,
  );
  const committed = await recent.next();
  assert(committed.type === "events");
  assert.deepEqual(committed.events, [concurrent]);
  assert.deepEqual(committed.snapshot?.state, JSON.parse(JSON.stringify(fold(store.readSince(0)).projects.orchard)));
  recent.send({ type: "projects.list", id: "replay-live" });
  assert.equal((await recent.next()).type, "projects.result");
});

// Each transport scenario owns a real SQLite store and an OS-assigned loopback port.
test("an oversized live event resets to an authoritative snapshot without dropping state", {
  timeout: 10000,
}, async (t) => {
  const store = new EventStore(":memory:");
  store.append({
    project: "orchard",
    kind: "session.claimed",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { ticket: "ORC-1", session: "s1", generation: 1, owner: "Mira", runtime: "codex", handle: "local" },
  });
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.equal((await client.next()).type, "project.subscribed");
  assert.equal((await client.next()).type, "events");
  const reason = "x".repeat(1_100_000);
  const posted = store.append({
    project: "orchard",
    kind: "session.reported",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { ticket: "ORC-1", session: "s1", phase: "implementing", reason },
  });
  const frame = await client.next();
  assert(frame.type === "events");
  assert.equal(frame.seq, posted.seq);
  assert.equal(frame.events.length, 0);
  assert(frame.snapshot);
  assert.equal((frame.snapshot.state as unknown as ProjectTables).sessions[0]?.reason, reason);
  client.send({ type: "projects.list" });
  assert.equal((await client.next()).type, "projects.result");
});

test("history reads are bounded newest-first SQL pages isolated by project and ticket", async (t) => {
  const store = new EventStore(":memory:");
  const expected: FleetEvent[] = [];
  for (let i = 0; i < 260; i++) {
    const row = store.append({
      project: i < 240 ? "orchard" : "harbor",
      kind: "ticket.report-posted",
      at: "2030-01-01T10:00:00Z",
      actor: "Mira",
      payload: {
        ticket: i < 225 ? "ORC-1" : "ORC-2",
        comment: `report-${i}`,
        updatedAt: "2030-01-01T10:00:00Z",
        phase: "implementing",
        summary: `Report ${i}`,
        body: `Saved report ${i}`,
        receipt: "internal",
      },
    } as EventInput);
    if (i < 225) expected.push(row);
  }
  store.append({
    project: "orchard",
    kind: "coordinator.checkpoint",
    at: "2030-01-01T10:00:00Z",
    actor: "coordinator",
    payload: { checkpoint: { format: "armada.pi", private: "document body" } },
  });
  const opened = store.append({
    project: "orchard",
    kind: "inbox.opened",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: "same-id", ticket: "ORC-1", kind: "question", body: "Which tree?" },
  });
  expected.push(opened);
  const answered = store.append({
    project: "orchard",
    kind: "inbox.answered",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: "same-id", answer: "Apple" },
  });
  expected.push(answered);
  store.append({
    project: "orchard",
    kind: "merge.queued",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: "same-id", ticket: "ORC-2", session: "other", pr: 9, head: "head" },
  });
  store.append({
    project: "orchard",
    kind: "merge.started",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: "same-id" },
  });
  const genericPayloads = [null, ["leaf", 7], 42, true, "note"];
  for (const payload of genericPayloads)
    store.append({
      project: "orchard",
      kind: "plugin.fixture",
      at: "2030-01-01T10:00:00Z",
      actor: "plugin",
      payload,
    } as unknown as EventInput);
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "fleet.history", project: "orchard" });
  const initial = await client.next();
  assert(initial.type === "fleet.history.result");
  assert.equal(initial.events.length, 50);
  assert(initial.cursor !== null);
  assert(
    initial.events.every((e, i, rows) => e.project === "orchard" && (!i || e.seq < (rows[i - 1] as FleetEvent).seq)),
  );
  assert(!JSON.stringify(initial).includes("document body"));
  assert(initial.events.every((e) => !e.payload || typeof e.payload !== "object" || !("receipt" in e.payload)));
  assert.deepEqual(
    initial.events.filter((e) => e.kind === "plugin.fixture").map((e) => e.payload),
    genericPayloads.toReversed(),
  );
  client.send({ type: "fleet.history", project: "orchard", ticket: "ORC-1", limit: 200 });
  const first = await client.next();
  assert(first.type === "fleet.history.result");
  assert.equal(first.events.length, 200);
  assert(first.cursor !== null);
  assert(first.events.some((e) => e.seq === answered.seq && (e.payload as { ticket: string }).ticket === "ORC-1"));
  client.send({ type: "fleet.history", project: "orchard", ticket: "ORC-1", cursor: first.cursor, limit: 200 });
  const second = await client.next();
  assert(second.type === "fleet.history.result");
  assert.equal(second.cursor, null);
  assert.deepEqual(
    [...first.events, ...second.events].map((e) => e.seq),
    expected.reverse().map((e) => e.seq),
  );
  client.send({ type: "fleet.history", project: "orchard", limit: 201 });
  const refused = await client.next();
  assert(refused.type === "error" && refused.code === "invalid-message");
  // Wide payloads lower the row count rather than produce an unbounded history frame.
  for (let i = 0; i < 2; i++)
    store.append({
      project: "orchard",
      kind: "ticket.report-posted",
      at: "2030-01-01T10:00:00Z",
      actor: "Mira",
      payload: {
        ticket: "ORC-1",
        comment: `wide-${i}`,
        updatedAt: "2030-01-01T10:00:00Z",
        phase: "implementing",
        summary: "Wide report",
        body: "x".repeat(700_000),
      },
    });
  client.send({ type: "fleet.history", project: "orchard" });
  const raw = await client.nextRaw();
  assert(Buffer.byteLength(raw) <= 1024 * 1024);
  const wide = serverMessageSchema.parse(JSON.parse(raw));
  assert(wide.type === "fleet.history.result");
  assert.equal(wide.events.length, 1);
  assert(wide.cursor !== null);
  client.send({ type: "projects.list" });
  assert.equal((await client.next()).type, "projects.result");
});

test("subscription returns folded state then committed batches, isolated and replaced by project", async (t) => {
  const store = new EventStore(":memory:");
  const first = store.append(hold());
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "projects.list" });
  assert.deepEqual(await client.next(), { type: "projects.result", version, id: "r1", projects });
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  const subscribed = await client.next();
  assert.equal(subscribed.type, "project.subscribed");
  if (subscribed.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.deepEqual(subscribed.snapshot, { seq: first.seq, state: holding(first) });
  // A fresh subscription starts at its snapshot cursor without replaying the log.
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: first.seq,
    events: [],
  });
  const foreign = store.append(hold("harbor"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: foreign.seq,
    events: [],
  });
  const later = store.append(hold("orchard", "sun"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: later.seq,
    events: [later],
    snapshot: { seq: later.seq, state: holding(first, later) },
  });
  client.send({ type: "project.subscribe", project: "orchard", after: later.seq });
  const replacement = await client.next();
  assert.equal(replacement.type, "project.subscribed");
  if (replacement.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.notEqual(replacement.subscriptionId, subscribed.subscriptionId);
  assert.equal(replacement.snapshot, undefined);
  const caughtUp = await client.next();
  assert(caughtUp.type === "events");
  // An interrupted replay may have applied its last event page but missed the final snapshot.
  assert.deepEqual(caughtUp.snapshot, { seq: later.seq, state: holding(first, later) });
  const newest = store.append(hold("orchard", "snow"));
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: replacement.subscriptionId,
    project: "orchard",
    seq: newest.seq,
    events: [newest],
    snapshot: { seq: newest.seq, state: holding(first, later, newest) },
  });
  // An ordered reply is a barrier: no duplicate delivery from the old subscription.
  client.send({ type: "projects.list", id: "barrier" });
  assert.equal((await client.next()).type, "projects.result");
});

test("a burst of appends in one task reaches a subscription as one frame with one refolded state", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  const subscribed = await client.next();
  if (subscribed.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.equal((await client.next()).type, "events");
  const burst = ["a", "b", "c"].map((id) => store.append(hold("orchard", id)));
  const last = burst.at(-1) as FleetEvent;
  assert.deepEqual(await client.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: last.seq,
    events: burst,
    snapshot: { seq: last.seq, state: holding(...burst) },
  });
  // An ordered reply is a barrier: no second frame for the same burst.
  client.send({ type: "projects.list", id: "barrier" });
  assert.equal((await client.next()).type, "projects.result");
});

test("reconnect after daemon/store restart replays only later events and refuses a future cursor", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-server-"));
  const path = join(dir, "fleet.sqlite");
  let store = new EventStore(path);
  let server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = store.append(hold());
  const client = await connect(server.wsUrl);
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.equal((await client.next()).type, "project.subscribed");
  const initial = await client.next();
  assert.equal(initial.type, "events");
  if (initial.type !== "events") throw new Error("Expected events");
  assert.equal(initial.seq, first.seq);
  await server.close();
  store.close();
  store = new EventStore(path);
  store.append(hold("harbor"));
  const later = store.append(hold("orchard", "sun"));
  server = await startServer({ store, projects });
  const resumed = await connect(server.wsUrl);
  resumed.send({ type: "project.subscribe", project: "orchard", after: initial.seq });
  const subscribed = await resumed.next();
  assert.equal(subscribed.type, "project.subscribed");
  if (subscribed.type !== "project.subscribed") throw new Error("Expected subscription");
  assert.equal(subscribed.after, initial.seq);
  assert.equal(subscribed.snapshot, undefined);
  assert.deepEqual(await resumed.next(), {
    type: "events",
    version,
    subscriptionId: subscribed.subscriptionId,
    project: "orchard",
    seq: later.seq,
    events: [later],
    snapshot: { seq: later.seq, state: holding(first, later) },
  });
  resumed.send({ type: "project.subscribe", project: "orchard", after: later.seq + 1 });
  const refused = await resumed.next();
  assert.equal(refused.type, "error");
  if (refused.type !== "error") throw new Error("Expected error");
  assert.equal(refused.code, "invalid-message");
  const live = store.append(hold("orchard", "wind"));
  const frame = await resumed.next();
  assert.equal(frame.type, "events");
  if (frame.type !== "events") throw new Error("Expected events");
  assert.deepEqual(frame.events, [live]);
  assert.equal(frame.subscriptionId, subscribed.subscriptionId);
});

test("session history includes only the requested session and not-found does not install subscriptions", async (t) => {
  const store = new EventStore(":memory:");
  const event = store.append({
    project: "orchard",
    kind: "session.claimed",
    at: hold().at,
    actor: "Mira",
    payload: {
      ticket: "ORC-1",
      session: "s1",
      generation: 1,
      owner: "Mira",
      runtime: "codex",
      handle: "local",
    },
  });
  assert.equal(event.kind, "session.claimed");
  if (event.kind !== "session.claimed") throw new Error("Expected claim");
  store.append({ ...event, payload: { ...event.payload, session: "s2", generation: 2 } });
  const launched = store.append({
    project: "orchard",
    kind: "coordinator.checkpoint",
    at: event.at,
    actor: "coordinator",
    payload: {
      checkpoint: {
        format: "armada.worker",
        version: 1,
        type: "launch",
        ticket: "ORC-1",
        session: "s1",
        generation: 1,
        runtime: "codex",
        step: "launched",
      },
    },
  });
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  client.send({ type: "session.read", project: "orchard", sessionId: "s1" });
  assert.deepEqual(await client.next(), {
    type: "session.result",
    version,
    id: "r1",
    project: "orchard",
    sessionId: "s1",
    seq: 3,
    events: [event, launched],
  });
  for (const request of [
    { type: "session.read", project: "orchard", sessionId: "missing" },
    { type: "session.read", project: "harbor", sessionId: "s1" },
    { type: "project.subscribe", project: "missing", after: 0 },
  ]) {
    client.send(request);
    const reply = await client.next();
    assert.equal(reply.type, "error");
    if (reply.type !== "error") throw new Error("Expected error");
    assert.equal(reply.code, "not-found");
  }
  store.append(hold());
  client.send({ type: "projects.list", id: "barrier" });
  assert.equal((await client.next()).type, "projects.result");
});

test("invalid requests recover; version refusal sends one line and closes before queued dispatch", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  for (const raw of [
    "{",
    JSON.stringify({ version, id: "bad", type: "project.subscribe", project: "orchard", after: -1 }),
  ]) {
    client.ws.send(raw);
    const reply = await client.next();
    assert.equal(reply.type, "error");
    if (reply.type !== "error") throw new Error("Expected error");
    assert.equal(reply.code, "invalid-message");
  }
  client.send({ type: "projects.list" });
  assert.equal((await client.next()).type, "projects.result");
  const received: unknown[] = [];
  client.ws.on("message", (data) => received.push(JSON.parse(String(data))));
  const closed = once(client.ws, "close");
  client.send({ type: "obsolete", version: { major: 0, minor: 99 } });
  client.send({ type: "projects.list", id: "must-not-dispatch" });
  await closed;
  assert.deepEqual(received, [
    {
      type: "error",
      version,
      id: "r1",
      code: "app-too-old",
      message: "Armada app is older than the daemon: update it",
    },
  ]);
});

test("HTTP serves built assets and SPA routes, refuses escapes and foreign browser origins", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-static-"));
  const secret = join(tmpdir(), `armada-outside-${process.pid}.txt`);
  writeFileSync(join(dir, "index.html"), "<html>Armada</html>");
  writeFileSync(join(dir, "app.js"), "window.armada = true;");
  writeFileSync(secret, "private");
  symlinkSync(secret, join(dir, "escape.txt"));
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects, staticDir: dir });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(secret);
  });
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await page.text(), "<html>Armada</html>");
  const asset = await fetch(`${server.url}/app.js`);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await asset.text(), "window.armada = true;");
  assert.equal((await fetch(`${server.url}/project/orchard`, { headers: { accept: "text/html" } })).status, 200);
  for (const path of ["/missing.js", "/escape.txt", "/..%2fprivate.txt", "/%00"]) {
    assert.equal((await fetch(`${server.url}${path}`)).status, 404, path);
  }
  const allowed = new WebSocket(server.wsUrl, { origin: server.url });
  await once(allowed, "open");
  allowed.terminate();
  // Exercise the rejected HTTP upgrade directly: Bun 1.4.2's ws compatibility
  // client does not expose ws's Node-only unexpected-response event.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      server.url,
      {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          Origin: "https://foreign.example",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Foreign origin unexpectedly upgraded"));
    });
    request.end();
  });
  assert.equal(status, 403);
});

test("credential socket writes never expose the key to replies, events or logs", {
  timeout: 10000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-credential-socket-"));
  const store = new EventStore(join(dir, "fleet.sqlite"));
  const backend = new FakeKeychain();
  const keychain = new Keychain(backend);
  const key = randomBytes(24).toString("hex");
  const logs: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const server = await startServer({ store, projects, keychain });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = await connect(server.wsUrl);
  const replies: ServerMessage[] = [];
  const next = async () => {
    const frame = await client.next();
    replies.push(frame);
    return frame;
  };
  client.send({ type: "credentials.status", id: "status-before" });
  assert.deepEqual(await next(), {
    type: "credentials.result",
    version,
    id: "status-before",
    provider: null,
    storage: "os-keychain",
  });
  // Enqueue read immediately after the write; asynchronous keychain operations must preserve order.
  client.send({ type: "credentials.set", id: "save", provider: "anthropic", key });
  client.send({ type: "credentials.status", id: "status-after" });
  assert.deepEqual(await next(), {
    type: "credentials.result",
    version,
    id: "save",
    provider: "anthropic",
    storage: "os-keychain",
  });
  assert.deepEqual(await next(), {
    type: "credentials.result",
    version,
    id: "status-after",
    provider: "anthropic",
    storage: "os-keychain",
  });
  assert.equal(store.sequence, 0);
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  await next();
  await next();
  const credential = await keychain.coordinator();
  assert.deepEqual(credential, { provider: "anthropic", key });
  const event = store.append({
    project: "orchard",
    kind: "coordinator.message",
    at: "2030-01-01T10:00:00Z",
    actor: "coordinator",
    payload: { role: "coordinator", body: "Ready to coordinate Orchard." },
  });
  const batch = await next();
  assert.equal(batch.type, "events");
  if (batch.type !== "events") throw new Error("Expected coordinator event");
  assert.deepEqual(batch.events, [event]);
  assert.equal(store.sequence, 1);
  assert.equal(JSON.stringify([replies, store.readSince(0), logs]).includes(key), false);
  for (const name of readdirSync(dir)) assert.equal(readFileSync(join(dir, name)).includes(Buffer.from(key)), false);
  const closed = once(client.ws, "close");
  client.ws.close();
  await closed;
  const reopened = await connect(server.wsUrl);
  reopened.send({ type: "credentials.status", id: "reconnected" });
  assert.deepEqual(await reopened.next(), {
    type: "credentials.result",
    version,
    id: "reconnected",
    provider: "anthropic",
    storage: "os-keychain",
  });
});

// Recorded before the vocabulary migration; the rules slice is an intentional additive extension.
// Only the random subscription UUID is normalized; THE-2043 intentionally advances
// the recorded envelope to minor 5 for per-client plan-policy snapshot projection,
// THE-2045 to minor 6 for the session page, THE-2049 to minor 7 for live chat,
// THE-2073 to minor 9 for shared auth and the pi model catalog,
// THE-2079 to minor 11 for fleet wake rows, THE-2080 to minor 12 for runtime projects,
// THE-2072 to minor 13 for hosted Conductor routing, and THE-2096 to minor 16 for routing instructions.
// THE-2116 advances it to minor 21, starts fresh subscriptions at their snapshot, and redacts checkpoint bodies.
test("subscription bytes stay compatible with the recorded daemon vocabulary and folded tables", async (t) => {
  const fixture = new URL("./support/protocol-subscription.json", import.meta.url);
  const inputs = JSON.parse(readFileSync(fixture, "utf8")) as { history: EventInput[]; live: EventInput[] };
  const store = new EventStore(":memory:");
  for (const event of inputs.history) store.append(event);
  const server = await startServer({ store, projects });
  t.after(async () => {
    await server.close();
    store.close();
  });
  const client = await connect(server.wsUrl);
  const frames: string[] = [];
  client.send({ type: "project.subscribe", project: "orchard", after: 0 });
  const initial = await client.nextRaw();
  const subscriptionId = JSON.parse(initial).subscriptionId as string;
  frames.push(initial.replaceAll(subscriptionId, "<subscription>"));
  frames.push((await client.nextRaw()).replaceAll(subscriptionId, "<subscription>"));
  for (const event of inputs.live) store.append(event);
  frames.push((await client.nextRaw()).replaceAll(subscriptionId, "<subscription>"));
  store.append(hold("harbor"));
  frames.push((await client.nextRaw()).replaceAll(subscriptionId, "<subscription>"));
  client.send({ type: "project.subscribe", project: "orchard", after: inputs.history.length });
  const replay = await client.nextRaw();
  const replayId = JSON.parse(replay).subscriptionId as string;
  frames.push(replay.replaceAll(replayId, "<subscription>"));
  frames.push((await client.nextRaw()).replaceAll(replayId, "<subscription>"));
  const recording = new URL("./support/protocol-subscription.ndjson", import.meta.url);
  assert.equal(`${frames.join("\n")}\n`, readFileSync(recording, "utf8"));
});

test("minor-4 clients retain readable legacy Rules in initial and live snapshots beside current clients", async (t) => {
  const store = new EventStore(":memory:");
  const gates = { requiredChecks: ["test"], localCommands: [] };
  const policy = { maxWorkers: 2, plans: "pre-approved", approvalLabel: "Review", preApprovedLabel: "Proceed" };
  const rules = (revision: number, maxWorkers = 2, withPolicy = true) =>
    store.append({
      project: "orchard",
      at: hold().at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          reason: "Plan rules",
          rules: { revision, value: { gates, ...(withPolicy ? { policy: { ...policy, maxWorkers } } : {}) } },
        },
      },
    });
  rules(1);
  const server = await startServer({ store, projects });
  // Legacy first exercises the shared fold cache before the current client's frame.
  const legacy = await connect(server.wsUrl);
  const modern = await connect(server.wsUrl);
  t.after(async () => {
    modern.ws.terminate();
    legacy.ws.terminate();
    await server.close();
    store.close();
  });
  const rulesValue = (frame: ServerMessage) => {
    assert(frame.type === "project.subscribed" || frame.type === "events");
    assert(frame.snapshot);
    return (frame.snapshot.state as unknown as { rules: { value: Record<string, unknown> } }).rules.value;
  };
  modern.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.deepEqual(rulesValue(await modern.next()), { gates, policy });
  await modern.next();
  legacy.send({ type: "project.subscribe", version: { major: version.major, minor: 4 }, project: "orchard", after: 0 });
  assert.deepEqual(rulesValue(await legacy.next()), { policy: { maxWorkers: 2 } });
  await legacy.next();
  rules(2, 3);
  assert.deepEqual(rulesValue(await modern.next()), { gates, policy: { ...policy, maxWorkers: 3 } });
  assert.deepEqual(rulesValue(await legacy.next()), { policy: { maxWorkers: 3 } });
  rules(3, 3, false);
  assert.deepEqual(rulesValue(await modern.next()), { gates });
  assert.deepEqual(rulesValue(await legacy.next()), {});
});

test("pre-wake clients keep their inbox vocabulary in initial and shared live snapshots", async (t) => {
  const store = new EventStore(":memory:");
  const open = (id: string, kind: InboxRequest["kind"]) =>
    store.append({
      project: "orchard",
      kind: "inbox.opened",
      at: hold().at,
      actor: "daemon",
      payload: { id, ticket: "ORC-1", kind, body: "Fleet notice" },
    });
  const notices = [
    "stopped",
    "silent",
    "not-started",
    "deploy",
    "job",
    "job-silent",
    "job-stalled",
    "version",
  ] as const;
  open("old", "hand-back");
  for (const kind of notices) open(kind, kind);
  const server = await startServer({ store, projects });
  // Legacy first also exercises the live batch's shared fold cache. Wake-capable
  // clients 11/12 retain their notices even below Conductor's newer minor.
  const clients: { minor: number; client: Awaited<ReturnType<typeof connect>> }[] = [];
  for (const minor of [10, 11, 12, version.minor]) clients.push({ minor, client: await connect(server.wsUrl) });
  t.after(async () => {
    for (const { client } of clients) client.ws.terminate();
    await server.close();
    store.close();
  });
  const inbox = (frame: ServerMessage) => {
    assert.ok(frame.type === "project.subscribed" || frame.type === "events");
    assert.ok(frame.snapshot);
    return (frame.snapshot.state as unknown as ProjectTables).inbox.map((item) => item.id);
  };
  for (const { minor, client } of clients) {
    client.send({ type: "project.subscribe", version: { major: 1, minor }, project: "orchard", after: 0 });
    assert.deepEqual(inbox(await client.next()), minor < 11 ? ["old"] : ["old", ...notices]);
    await client.next();
  }
  open("later", "silent");
  for (const { minor, client } of clients)
    assert.deepEqual(inbox(await client.next()), minor < 11 ? ["old"] : ["old", ...notices, "later"]);
});

test("pre-Conductor clients receive compatible routing in initial and live snapshots", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  const legacy = await connect(server.wsUrl);
  const modern = await connect(server.wsUrl);
  t.after(async () => {
    legacy.ws.terminate();
    modern.ws.terminate();
    await server.close();
    store.close();
  });
  const route = { cli: "conductor" as const, model: "web" };
  const rules = (revision: number) =>
    store.append({
      project: "orchard",
      actor: "coordinator",
      at: hold().at,
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          rules: { revision, value: { routing: [{ labels: ["web"], ...route }], defaultRoute: route } },
        },
      },
    });
  const value = (frame: ServerMessage) => {
    assert(frame.type === "project.subscribed" || frame.type === "events");
    assert(frame.snapshot);
    return (frame.snapshot.state as unknown as { rules: { value: unknown } }).rules.value;
  };
  rules(1);
  legacy.send({ type: "project.subscribe", project: "orchard", after: 0, version: { major: 1, minor: 12 } });
  modern.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.deepEqual(value(await legacy.next()), { routing: [], defaultRoute: null });
  assert.deepEqual(value(await modern.next()), { routing: [{ labels: ["web"], ...route }], defaultRoute: route });
  await legacy.next();
  await modern.next();
  rules(2);
  assert.deepEqual(value(await legacy.next()), { routing: [], defaultRoute: null });
  assert.deepEqual(value(await modern.next()), { routing: [{ labels: ["web"], ...route }], defaultRoute: route });
});

test("pre-16 clients receive routes without instructions in initial and live snapshots", async (t) => {
  const store = new EventStore(":memory:");
  const server = await startServer({ store, projects });
  const legacy = await connect(server.wsUrl);
  const modern = await connect(server.wsUrl);
  t.after(async () => {
    legacy.ws.terminate();
    modern.ws.terminate();
    await server.close();
    store.close();
  });
  const route = { cli: "claude", model: "orchard", instructions: "Review the irrigation." };
  const record = (revision: number) =>
    store.append({
      project: "orchard",
      actor: "coordinator",
      at: hold().at,
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          rules: { revision, value: { routing: [{ labels: ["api"], ...route }], defaultRoute: route } },
        },
      },
    });
  const value = (frame: ServerMessage) => {
    assert(frame.type === "project.subscribed" || frame.type === "events");
    assert(frame.snapshot);
    return (frame.snapshot.state as unknown as { rules: { value: unknown } }).rules.value;
  };
  const expected = { routing: [{ labels: ["api"], ...route }], defaultRoute: route };
  const old = {
    routing: [{ labels: ["api"], cli: "claude", model: "orchard" }],
    defaultRoute: { cli: "claude", model: "orchard" },
  };
  record(1);
  legacy.send({ type: "project.subscribe", project: "orchard", after: 0, version: { major: 1, minor: 15 } });
  modern.send({ type: "project.subscribe", project: "orchard", after: 0 });
  assert.deepEqual(value(await legacy.next()), old);
  assert.deepEqual(value(await modern.next()), expected);
  await legacy.next();
  await modern.next();
  record(2);
  assert.deepEqual(value(await legacy.next()), old);
  assert.deepEqual(value(await modern.next()), expected);
});
