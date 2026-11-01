import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetStatus } from "../coordinator/read.ts";
import { wakeups } from "../coordinator/wake.ts";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";

test("conflict and behind facts become ticket wake candidates and fleet head state; comments do not", () => {
  const store = new EventStore(":memory:");
  const common = { project: "boats", actor: "github", at: "2030-01-01T12:00:00Z" };
  const reading = () => ({ tables: fold(store.readSince(0)).projects.boats, events: store.readSince(0) });
  try {
    store.append({
      ...common,
      kind: "session.claimed",
      payload: {
        ticket: "BOAT-7",
        session: "worker-1",
        generation: 1,
        owner: "worker",
        runtime: "codex",
        handle: "handle-1",
      },
    });
    const before = reading();
    store.append({
      ...common,
      kind: "pull-request.seen",
      payload: {
        number: 41,
        ticket: "BOAT-7",
        state: "open",
        ci: "pending",
        head: "a".repeat(40),
        base: "b".repeat(40),
        conflicting: true,
        behind: true,
        unresolvedThreads: 2,
      },
    });
    const after = reading();
    const candidates = wakeups(before, after);
    assert.deepEqual(
      candidates.map((c) => c.facts.state),
      ["conflicting", "behind"],
    );
    assert.ok(candidates.every((c) => c.facts.ticket === "BOAT-7" && c.facts.pr === 41));
    assert.deepEqual(wakeups(after, after), []);
    assert.ok(after.tables);
    const status = fleetStatus(after.tables, store.readSince(0), common.at);
    assert.equal(status.sessions[0]?.conflicting, true);
    assert.equal(status.sessions[0]?.behind, true);
    assert.equal(status.sessions[0]?.unresolvedThreads, 2);
    store.append({
      ...common,
      kind: "pull-request.commented",
      payload: {
        key: "comment:1",
        repository: "acme/boats",
        ticket: "BOAT-7",
        pr: 41,
        head: "a".repeat(40),
        author: "owner",
        body: "Please fix",
        url: "https://github.com/acme/boats/pull/41#discussion_r1",
        at: common.at,
        comment: "1",
      },
    });
    assert.deepEqual(wakeups(after, reading()), []);
  } finally {
    store.close();
  }
});
