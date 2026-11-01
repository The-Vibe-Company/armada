import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fleetStatus } from "../coordinator/read.ts";
import { Deliveries, queueDelivery } from "../src/deliveries.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";

const project = "orchard";
const at = "2030-01-01T00:00:00.000Z";
const session = { ticket: "SEED-1", session: "one", generation: 1 };
function seed(store: EventStore, ref = session) {
  store.append({
    project,
    at,
    actor: "worker",
    kind: "session.claimed",
    payload: { ...ref, owner: "coordinator", runtime: "codex", handle: `local/${ref.session}` },
  });
}
const queued = (key: string, text = key, ref = session) =>
  queueDelivery({ project, at, actor: "owner", ...ref, source: "owner-answer", text, key });
async function settle() {
  // Drain asynchronous attempts and commit notices, without elapsed-time sleeps.
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function clock() {
  let time = Date.parse(at);
  const tasks = new Set<{ at: number; run: () => void }>();
  return {
    now: () => new Date(time).toISOString(),
    schedule(run: () => void, delay: number) {
      const task = { at: time + delay, run };
      tasks.add(task);
      return () => {
        tasks.delete(task);
      };
    },
    async advance(ms: number) {
      time += ms;
      for (const task of [...tasks])
        if (task.at <= time) {
          tasks.delete(task);
          task.run();
        }
      await settle();
    },
  };
}

test("durable delivery retries twice then sends once without opening an item", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const time = clock();
  const received: string[] = [];
  const keys: string[] = [];
  let attempts = 0;
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(d, guard) {
      guard();
      keys.push(d.key);
      if (++attempts < 3) throw new Error("PTY unavailable");
      received.push(d.text);
    },
  });
  try {
    store.append(queued("answer", "Plant oak"));
    await settle();
    assert.equal(attempts, 1);
    await time.advance(1999);
    assert.equal(attempts, 1);
    await time.advance(1);
    assert.equal(attempts, 2);
    await time.advance(4000);
    assert.deepEqual(received, ["Plant oak"]);
    assert.deepEqual(keys, ["answer", "answer", "answer"]);
    assert.equal(store.readSince(0).filter((e) => e.kind === "delivery.failed").length, 2);
    assert.equal(store.readSince(0).filter((e) => e.kind === "delivery.sent").length, 1);
    assert.equal(fold(store.readSince(0)).projects[project]?.inbox.length, 0);
  } finally {
    await driver.close();
    store.close();
  }
});

test("three failures open one stable item and status problem, cleared by a later send", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const time = clock();
  let fail = true;
  const keys: string[] = [];
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(d, guard) {
      guard();
      keys.push(d.key);
      if (fail) throw new Error("PTY unavailable");
    },
  });
  const facts = () => fold(store.readSince(0)).projects[project]!;
  try {
    store.append(queued("answer"));
    await settle();
    await time.advance(2000);
    await time.advance(4000);
    const item = facts().inbox[0];
    assert.equal(item?.kind, "delivery-failed");
    assert.match(item?.body ?? "", /Answer not delivered to SEED-1/);
    assert.equal(fleetStatus(facts(), store.readSince(0), time.now()).problems.deliveries[0]?.ticket, "SEED-1");
    await time.advance(8000);
    assert.deepEqual(facts().inbox, [item]);
    assert.deepEqual(keys, ["answer", "answer", "answer", "answer"]);
    fail = false;
    await time.advance(16000);
    assert.deepEqual(facts().inbox, []);
    assert.deepEqual(fleetStatus(facts(), store.readSince(0), time.now()).problems.deliveries, []);
  } finally {
    await driver.close();
    store.close();
  }
});

test("boot resumes an on-disk queued delivery once, and sent evidence survives another restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-outbox-"));
  const path = join(directory, "events.sqlite");
  let store = new EventStore(path);
  seed(store);
  store.append(queued("answer"));
  store.close();
  const received: string[] = [];
  try {
    for (let restart = 0; restart < 2; restart++) {
      store = new EventStore(path);
      const driver = new Deliveries({
        store,
        now: () => at,
        async deliver(d, guard) {
          guard();
          received.push(d.text);
        },
      });
      await settle();
      await driver.close();
      store.close();
    }
    assert.deepEqual(received, ["answer"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a retry blocks later inputs to its session while another session can progress", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const other = { ticket: "SEED-2", session: "two", generation: 1 };
  seed(store, other);
  const time = clock();
  const received: string[] = [];
  let first = true;
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(d, guard) {
      guard();
      if (d.text === "answer" && first) {
        first = false;
        throw new Error("PTY unavailable");
      }
      received.push(d.text);
    },
  });
  try {
    store.appendMany([queued("answer"), queued("note"), queued("other", "other", other)]);
    await settle();
    assert.deepEqual(received, ["other"]);
    await time.advance(2000);
    assert.deepEqual(received, ["other", "answer", "note"]);
  } finally {
    await driver.close();
    store.close();
  }
});

test("generation changes fail permanently before a write and session end closes its failure item", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const time = clock();
  let writes = 0;
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(_d, guard) {
      guard();
      writes++;
      throw new Error("PTY unavailable");
    },
  });
  try {
    store.append(queued("answer"));
    await settle();
    await time.advance(2000);
    await time.advance(4000);
    assert.equal(fold(store.readSince(0)).projects[project]?.inbox.length, 1);
    seed(store, { ...session, session: "replacement", generation: 2 });
    await settle();
    const failure = store.readSince(0).findLast((e) => e.kind === "delivery.failed");
    assert.equal(failure?.kind, "delivery.failed");
    if (failure?.kind === "delivery.failed") {
      assert.equal(failure.payload.nextAt, null);
      assert.match(failure.payload.error, /generation changed/i);
    }
    await time.advance(60000);
    assert.equal(writes, 3);
    assert.deepEqual(fold(store.readSince(0)).projects[project]?.inbox, []);
  } finally {
    await driver.close();
    store.close();
  }
});

test("an asynchronous attempt rechecks generation immediately before the native write", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  let proceed!: () => void;
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let entered = false;
  let writes = 0;
  const driver = new Deliveries({
    store,
    now: () => at,
    async deliver(_d, guard) {
      entered = true;
      await gate;
      guard();
      writes++;
    },
  });
  try {
    store.append(queued("answer"));
    await settle();
    assert.equal(entered, true);
    seed(store, { ...session, session: "replacement", generation: 2 });
    proceed();
    await settle();
    assert.equal(writes, 0);
    assert.equal(store.readSince(0).filter((e) => e.kind === "delivery.sent").length, 0);
  } finally {
    proceed();
    await driver.close();
    store.close();
  }
});

test("a running completion cannot acknowledge a superseding payload and duplicate intents coalesce", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const time = clock();
  let proceed!: () => void;
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const received: string[] = [];
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(d, guard) {
      if (d.text === "old") await gate;
      guard();
      received.push(d.text);
    },
  });
  try {
    store.append(queued("answer", "old"));
    await settle();
    store.append(queued("answer", "new"));
    store.append(queued("answer", "new"));
    proceed();
    await settle();
    assert.deepEqual(received, ["new"]);
    assert.equal(store.readSince(0).filter((e) => e.kind === "delivery.sent").length, 1);
  } finally {
    proceed();
    await driver.close();
    store.close();
  }
});

test("backoff caps at sixty seconds and a released session closes its failure item", async () => {
  const store = new EventStore(":memory:");
  seed(store);
  const time = clock();
  const driver = new Deliveries({
    store,
    ...time,
    async deliver(_d, guard) {
      guard();
      throw new Error("private runtime text");
    },
  });
  try {
    store.append(queued("answer"));
    await settle();
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) await time.advance(delay);
    const failures = store.readSince(0).filter((e) => e.kind === "delivery.failed");
    assert.deepEqual(
      failures.map((e) => Date.parse(e.payload.nextAt ?? "") - Date.parse(e.at)),
      [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000],
    );
    assert.doesNotMatch(JSON.stringify(failures), /private runtime text/);
    assert.equal(fold(store.readSince(0)).projects[project]?.inbox.length, 1);
    store.append({
      project,
      at: time.now(),
      actor: "worker",
      kind: "session.released",
      payload: { ticket: session.ticket, session: session.session, reason: "Finished" },
    });
    await settle();
    assert.deepEqual(fold(store.readSince(0)).projects[project]?.inbox, []);
  } finally {
    await driver.close();
    store.close();
  }
});
