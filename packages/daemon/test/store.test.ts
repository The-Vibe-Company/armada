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
