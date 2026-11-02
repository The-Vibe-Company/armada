import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EventStore } from "../src/store.ts";

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
    const read = t.mock.method(store, "readSince");
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
