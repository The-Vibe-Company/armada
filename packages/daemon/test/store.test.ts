import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { EventInput, Json } from "../src/events.ts";
import { FOLD_VERSION, FoldAccumulator, fold } from "../src/fold.ts";
import { EventStore, SNAPSHOT_EVERY } from "../src/store.ts";

/** The fold's consumers read JSON: an absent key and an undefined one are the same reading. */
const json = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const checkpoint = (actor: string, checkpoint: Json, at = "2030-01-01T10:00:00Z"): EventInput => ({
  project: "orchard",
  kind: "coordinator.checkpoint",
  at,
  actor,
  payload: { checkpoint },
});
/** A mixed log: every checkpoint format the fold reads, two of them superseded. */
function mixedLog(): EventInput[] {
  const at = "2030-01-01T10:00:00Z";
  const blob = { pages: Array.from({ length: 40 }, (_, i) => ({ id: i, body: "x".repeat(200) })) };
  return [
    {
      project: "orchard",
      kind: "ticket.seen",
      at,
      actor: "linear",
      payload: { id: "ORC-1", title: "Plant", status: "started", phase: "implementing" },
    },
    checkpoint("armada.github-reader", { format: "armada.github-reader", version: 1, ...blob }),
    checkpoint("armada.linear-reader", {
      format: "armada.linear-reader",
      version: 1,
      usage: { hour: at, requests: 900, pausedUntil: null },
      ...blob,
    }),
    checkpoint("coordinator", { format: "armada.readers", version: 1, provider: "linear" }),
    checkpoint("coordinator", {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 1, value: { policy: { budget: { zone: "Europe/Paris" } } } },
    }),
    checkpoint("coordinator", {
      format: "armada.worker",
      version: 1,
      type: "launch",
      step: "launched",
      ticket: "ORC-1",
      session: "sprout",
      generation: 1,
      runtime: "local",
      handle: "pane-a",
    }),
    checkpoint("coordinator", {
      format: "armada.pi",
      version: 1,
      type: "commit",
      seq: 1,
      writes: [
        {
          type: "entry",
          value: {
            id: 1,
            conversationId: 1,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                model: "oak",
                provider: "fixture",
                usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      ],
    }),
    // A completed turn keeps its payload whatever its checkpoint says.
    {
      project: "orchard",
      kind: "coordinator.checkpoint",
      at,
      actor: "coordinator",
      payload: {
        checkpoint: { format: "armada.github-reader", version: 1 },
        turn: { id: "turn-2", session: "root" },
        usage: { input: 5, output: 5, cacheRead: null, cacheWrite: null, model: "oak", provider: "fixture" },
      },
    },
    checkpoint("armada.github-reader", { format: "armada.github-reader", version: 1, ...blob }),
    checkpoint("armada.linear-reader", {
      format: "armada.linear-reader",
      version: 1,
      usage: { hour: at, requests: 850, pausedUntil: null },
      ...blob,
    }),
    {
      project: "orchard",
      kind: "session.claimed",
      at,
      actor: "worker",
      payload: { ticket: "ORC-1", session: "sprout", generation: 1, owner: "Mira", runtime: "local", handle: "pane-a" },
    },
    {
      project: "orchard",
      kind: "session.usage",
      at,
      actor: "worker",
      payload: {
        ticket: "ORC-1",
        session: "sprout",
        generation: 1,
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, model: "oak", provider: "fixture" },
      },
    },
    { project: "harbor", kind: "hold.opened", at, actor: "Ivo", payload: { id: "tide", reason: "Wait" } },
  ];
}

test("durable append, exclusive replay cursor and project isolation use the committed sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-events-"));
  const path = join(dir, "fleet.sqlite");
  try {
    const store = new EventStore(path);
    const first = store.append({
      project: "orchard",
      kind: "hold.opened",
      at: "2030-01-01T10:00:00Z",
      actor: "Mira",
      payload: { id: "rain", reason: "Wait for CI" },
    });
    const other = store.append({
      project: "harbor",
      kind: "coordinator.checkpoint",
      at: "2029-01-01T10:00:00Z",
      actor: "Ivo",
      payload: { checkpoint: { turn: 2, messages: ["hello", null] } },
    });
    const last = store.append({
      project: "orchard",
      kind: "hold.cleared",
      at: first.at,
      actor: "Mira",
      payload: { id: "rain", reason: "CI recovered" },
    });
    assert.deepEqual([first.seq, other.seq, last.seq], [1, 2, 3]);
    assert.deepEqual(store.readSince(first.seq), [other, last]);
    assert.deepEqual(store.readSince(0, "orchard"), [first, last]);
    assert.deepEqual(store.readSince(last.seq), []);
    store.close();
    const reopened = new EventStore(path);
    try {
      assert.deepEqual(reopened.readSince(0), [first, other, last]);
      assert.equal(
        reopened.append({
          project: "harbor",
          kind: "coordinator.message",
          at: first.at,
          actor: "Ivo",
          payload: { role: "owner", body: "Continue" },
        }).seq,
        4,
      );
      assert.throws(() => reopened.readSince(-1), /sequence/);
      assert.throws(() => reopened.readSince(0.5), /sequence/);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the database refuses rewriting or deleting history, including SQL replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-events-"));
  const path = join(dir, "fleet.sqlite");
  try {
    const store = new EventStore(path);
    const original = store.append({
      project: "orchard",
      kind: "hold.opened",
      at: "2030-01-01T10:00:00Z",
      actor: "Mira",
      payload: { id: "rain", reason: "Wait" },
    });
    const sql = new DatabaseSync(path);
    try {
      assert.throws(() => sql.exec("UPDATE events SET actor = 'Someone else'"), /append-only/);
      assert.throws(() => sql.exec("DELETE FROM events"), /append-only/);
      assert.throws(() => sql.exec("INSERT OR REPLACE INTO events SELECT * FROM events"), /append-only/);
      assert.deepEqual(store.readSince(0), [original]);
    } finally {
      sql.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project folds reuse a committed cursor, stay detached, and refresh before append observers", (t) => {
  const store = new EventStore(":memory:");
  const event = {
    project: "orchard",
    kind: "hold.opened",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: "rain", reason: "Wait for CI" },
  } as const;
  try {
    store.append(event);
    const read = t.mock.method(store, "readForFold");
    const first = store.fold("orchard");
    assert.equal(first.projects.orchard?.holds[0]?.reason, "Wait for CI");
    first.projects.orchard!.holds[0]!.reason = "Caller mutation";
    assert.equal(store.fold("orchard").projects.orchard?.holds[0]?.reason, "Wait for CI");
    assert.equal(read.mock.callCount(), 1, "one replay per project at the committed cursor");
    const empty = store.fold("constructor");
    assert.deepEqual(Object.keys(empty.projects), []);
    assert.equal(empty.projects.constructor, undefined, "missing project names never resolve through Object.prototype");
    assert.equal(read.mock.callCount(), 2, "projects have distinct cache entries");
    assert.throws(() => store.appendMany([event, { ...event, project: "" }]));
    assert.equal(store.fold("orchard").seq, 1);
    assert.equal(read.mock.callCount(), 2, "rollback preserves the committed cache");
    let observed = "";
    store.subscribe(() => {
      observed = store.fold("orchard").projects.orchard?.holds[0]?.reason ?? "";
    });
    store.appendMany([
      { ...event, kind: "hold.cleared", payload: { id: "rain", reason: "CI recovered" } },
      { ...event, payload: { id: "sun", reason: "Wait for deploy" } },
    ]);
    assert.equal(observed, "Wait for deploy", "commit invalidates before observers run");
    assert.equal(store.fold("orchard").seq, 3);
    assert.equal(store.fold("constructor").projects.constructor, undefined);
    assert.equal(read.mock.callCount(), 4);
  } finally {
    store.close();
  }
});

test("atomic append builders read the current fold across connections and roll back rejected batches", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-atomic-events-"));
  const path = join(dir, "fleet.sqlite");
  const first = new EventStore(path);
  const second = new EventStore(path);
  const make = (id: string) => ({
    project: "orchard",
    kind: "ticket.created" as const,
    actor: "Mira",
    at: "2030-01-01T00:00:00Z",
    payload: { id, title: "Plant", description: "", labels: [], state: "backlog" as const, parent: null, blockers: [] },
  });
  try {
    // Prime a cached empty fold, then commit from the other connection.
    first.fold("orchard");
    second.append(make("ORCHA-9"));
    const notices: number[] = [];
    first.subscribe(() => notices.push(first.fold("orchard").projects.orchard?.tickets.length ?? 0));
    first.appendWith("orchard", (tables) => {
      assert.equal(tables.projects.orchard?.tickets[0]?.id, "ORCHA-9");
      return [make("ORCHA-10"), make("ORCHA-11")];
    });
    assert.deepEqual(notices, [3]);
    const cursor = first.sequence;
    assert.throws(
      () => first.appendWith("orchard", () => [make("ORCHA-12"), { ...make("OTHER-1"), project: "other" }]),
      /project mismatch/,
    );
    assert.throws(
      () =>
        first.appendWith("orchard", (tables) => {
          tables.projects.orchard!.tickets.length = 0;
          throw new Error("fenced");
        }),
      /fenced/,
    );
    assert.equal(first.sequence, cursor);
    assert.equal(first.fold("orchard").projects.orchard?.tickets.length, 3);
    assert.deepEqual(notices, [3], "a rolled-back batch has no commit notification");
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store's fold equals the pure fold while superseded latest-wins checkpoints are stubbed, not parsed", () => {
  const store = new EventStore(":memory:");
  try {
    const stored = store.appendMany(mixedLog());
    const read = store.readForFold(0, "orchard");
    const stubbed = read.events.filter((e) => e.kind === "coordinator.checkpoint" && e.payload.checkpoint === null);
    assert.deepEqual(
      stubbed.map((e) => e.seq),
      [stored[1]!.seq, stored[2]!.seq, stored[8]!.seq],
      "both github-reader rows and the superseded linear-reader row",
    );
    assert.equal(read.parsed, read.events.length - 3);
    assert.equal(read.events.length, stored.length - 1, "the other project's row is not read");
    const expected = fold(store.readSince(0, "orchard"));
    assert.deepEqual(json(store.fold("orchard")), json(expected));
    const orchard = store.fold("orchard").projects.orchard;
    assert.equal(orchard?.readers?.linear?.requests, 850, "the latest linear-reader row wins");
    assert.equal(orchard?.usage?.zone, "Europe/Paris");
    assert.equal(orchard?.usage?.days[0]?.coordinator.input, 105);
    assert.equal(orchard?.usage?.days[0]?.workers.input, 10);
    assert.equal(orchard?.usage?.days[0]?.workerLaunches, 1);
    assert.deepEqual(store.readSince(stored[1]!.seq - 1, "orchard", 1)[0], stored[1], "readSince is unchanged");
    assert.throws(() => store.readForFold(-1, "orchard"), /sequence/);
  } finally {
    store.close();
  }
});

test("a snapshot is written after SNAPSHOT_EVERY rows and on close, and a reopened store replays only the rest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armada-snapshot-"));
  const path = join(dir, "fleet.sqlite");
  const hold = (i: number): EventInput => ({
    project: "orchard",
    kind: "hold.opened",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id: `hold-${i}`, reason: `Reason ${i}` },
  });
  const snapshotRow = (db: DatabaseSync) =>
    json(
      db.prepare("SELECT fold_version, seq FROM fold_snapshots WHERE project = 'orchard'").get() as
        | { fold_version: number; seq: number }
        | undefined,
    );
  try {
    const store = new EventStore(path);
    const sql = new DatabaseSync(path);
    try {
      store.appendMany(mixedLog());
      store.fold("orchard");
      assert.equal(snapshotRow(sql), undefined, "a short replay writes no snapshot yet");
      store.appendMany(Array.from({ length: SNAPSHOT_EVERY }, (_, i) => hold(i)));
      store.fold("orchard");
      const written = snapshotRow(sql);
      assert.deepEqual(written, { fold_version: FOLD_VERSION, seq: store.fold("orchard").seq });
      store.append(hold(SNAPSHOT_EVERY));
      store.fold("orchard");
      assert.equal(snapshotRow(sql)?.seq, written?.seq, "one row past the snapshot is not written yet");
    } finally {
      sql.close();
      store.close();
    }
    const closed = new DatabaseSync(path);
    const atClose = snapshotRow(closed);
    closed.close();
    const reopened = new EventStore(path);
    try {
      assert.equal(atClose?.seq, reopened.sequence, "close stores the reading at the committed cursor");
      const tail = reopened.appendMany([hold(100), hold(101)]);
      assert.equal(reopened.pending(["orchard", "harbor", "orchard"]), 2 + 1);
      const read = t.mock.method(reopened, "readForFold");
      const warmup = reopened.warm("orchard");
      assert.equal(warmup.from, atClose?.seq);
      assert.equal(warmup.replayed, 2);
      assert.equal(warmup.parsed, 2);
      assert.equal(warmup.ignored, undefined);
      assert.deepEqual(read.mock.calls[0]?.arguments, [atClose?.seq, "orchard"]);
      assert.deepEqual(json(reopened.fold("orchard")), json(fold(reopened.readSince(0, "orchard"))));
      assert.equal(reopened.fold("orchard").seq, tail[1]!.seq);
      assert.equal(read.mock.callCount(), 1, "the warm reading serves the next fold");
      const after = new DatabaseSync(path);
      try {
        assert.equal(snapshotRow(after)?.seq, tail[1]!.seq, "a warm-up that replayed anything stores its reading");
      } finally {
        after.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or foreign-version snapshot row is ignored and rebuilt from the log, never a boot failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-snapshot-corrupt-"));
  const path = join(dir, "fleet.sqlite");
  const expected = json(fold(mixedLog().map((e, i) => ({ ...e, seq: i + 1 })) as never).projects.orchard);
  const plant = (fold_version: number, state: string, seq = 3) => {
    const sql = new DatabaseSync(path);
    try {
      sql
        .prepare("INSERT OR REPLACE INTO fold_snapshots (project, fold_version, seq, state) VALUES (?, ?, ?, ?)")
        .run("orchard", fold_version, seq, state);
    } finally {
      sql.close();
    }
  };
  try {
    const seeded = new EventStore(path);
    seeded.appendMany(mixedLog());
    seeded.fold("orchard");
    seeded.close();
    const valid = new DatabaseSync(path);
    const stored = valid.prepare("SELECT state FROM fold_snapshots WHERE project = 'orchard'").get()?.state as string;
    valid.close();
    assert.match(stored, /"models":\["oak"\]/);
    const cases = [
      ["garbage", FOLD_VERSION, "{not json", 3],
      ["wrong shape", FOLD_VERSION, JSON.stringify({ version: FOLD_VERSION, seq: 3, projects: [["orchard", 7]] }), 3],
      ["foreign version", FOLD_VERSION + 1, stored, 12],
      ["a cursor ahead of the log", FOLD_VERSION, stored.replace(/"seq":\d+/, '"seq":999'), 999],
      // Passes restore's shape checks, then breaks the fold itself when it reads the state.
      ["values the fold cannot read", FOLD_VERSION, stored.replaceAll('"models":["oak"]', '"models":5'), 12],
    ] as const;
    for (const [name, version, state, seq] of cases) {
      plant(version, state, seq);
      const store = new EventStore(path);
      try {
        if (seq !== 12) assert.equal(store.pending(["orchard"]), 12, `${name}: the whole log is pending`);
        const warmup = store.warm("orchard");
        assert.match(warmup.ignored ?? "", /./, `${name}: the ignored reason is reported`);
        assert.equal(warmup.from, 0, name);
        assert.equal(warmup.replayed, 12, name);
        assert.deepEqual(json(store.fold("orchard").projects.orchard), expected, name);
        const sql = new DatabaseSync(path);
        try {
          const row = sql
            .prepare("SELECT fold_version, seq, state FROM fold_snapshots WHERE project = 'orchard'")
            .get();
          assert.equal(row?.fold_version, FOLD_VERSION, `${name}: rewritten at the current version`);
          assert.equal(row?.seq, 12, `${name}: rewritten at the log's cursor`);
          assert.equal(row?.state, stored, `${name}: the rebuilt reading equals the valid one`);
        } finally {
          sql.close();
        }
      } finally {
        store.close();
      }
    }
    // A project reached only through fold() replaces a rejected row once the debounce allows.
    const grown = new EventStore(path);
    grown.appendMany(
      Array.from({ length: SNAPSHOT_EVERY }, (_, i) => ({
        project: "orchard",
        kind: "hold.opened" as const,
        at: "2030-01-01T10:00:00Z",
        actor: "Mira",
        payload: { id: `hold-${i}`, reason: "Wait" },
      })),
    );
    grown.close();
    plant(FOLD_VERSION, stored.replaceAll('"models":["oak"]', '"models":5').replace(/"seq":\d+/, '"seq":77'), 77);
    const folded = new EventStore(path);
    try {
      assert.equal(folded.fold("orchard").projects.orchard?.holds.length, SNAPSHOT_EVERY);
      const sql = new DatabaseSync(path);
      try {
        const row = sql.prepare("SELECT seq, state FROM fold_snapshots WHERE project = 'orchard'").get();
        assert.equal(row?.seq, 77);
        assert.doesNotThrow(() => FoldAccumulator.restore(row?.state as string).snapshot(), "a readable row again");
      } finally {
        sql.close();
      }
    } finally {
      folded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two connections each resume the fold from rows the other committed", () => {
  const dir = mkdtempSync(join(tmpdir(), "armada-snapshot-pair-"));
  const path = join(dir, "fleet.sqlite");
  const first = new EventStore(path);
  const second = new EventStore(path);
  const hold = (id: string): EventInput => ({
    project: "orchard",
    kind: "hold.opened",
    at: "2030-01-01T10:00:00Z",
    actor: "Mira",
    payload: { id, reason: `Wait for ${id}` },
  });
  try {
    first.appendMany(mixedLog());
    assert.equal(second.fold("orchard").projects.orchard?.tickets.length, 1);
    second.appendMany(Array.from({ length: SNAPSHOT_EVERY + 1 }, (_, i) => hold(`h${i}`)));
    assert.equal(second.fold("orchard").projects.orchard?.holds.length, SNAPSHOT_EVERY + 1, "second stores a snapshot");
    first.append(hold("late"));
    assert.deepEqual(json(first.fold("orchard")), json(fold(first.readSince(0, "orchard"))));
    assert.deepEqual(json(second.fold("orchard")), json(fold(second.readSince(0, "orchard"))));
    assert.equal(second.fold("orchard").projects.orchard?.holds.at(-1)?.id, "late");
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a latest-wins checkpoint without a readable usage never hides the earlier reading", () => {
  const store = new EventStore(":memory:");
  const at = "2030-01-01T10:00:00Z";
  const reading = (requests: number) =>
    checkpoint("armada.linear-reader", {
      format: "armada.linear-reader",
      version: 1,
      usage: { hour: at, requests, pausedUntil: null },
    });
  try {
    const stored = store.appendMany([
      reading(900),
      reading(850),
      // A cursor-only checkpoint, as the tracker writes without a budget.
      checkpoint("armada.linear-reader", { format: "armada.linear-reader", version: 1, cursor: "abc" }),
      checkpoint("armada.linear-reader", { format: "armada.linear-reader", version: 2, usage: { hour: at } }),
    ]);
    const read = store.readForFold(0, "orchard");
    assert.deepEqual(
      read.events.map((e) => e.kind === "coordinator.checkpoint" && e.payload.checkpoint === null),
      [true, false, false, false],
      "only the superseded readable row is stubbed",
    );
    assert.equal(read.parsed, 3);
    assert.deepEqual(json(store.fold("orchard")), json(fold(store.readSince(0, "orchard"))));
    assert.equal(store.fold("orchard").projects.orchard?.readers?.linear?.requests, 850);
    assert.equal(store.fold("orchard").seq, stored[3]!.seq);
  } finally {
    store.close();
  }
});
