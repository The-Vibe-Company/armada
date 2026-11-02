import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fold } from "@armada/daemon/fold";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { bootDaemon } from "../../../daemon/src/boot.ts";
import { startReaders } from "../../../daemon/src/server/readers.ts";
import pkg from "../package.json" with { type: "json" };
import { activate } from "../src/index.ts";

const catalog = [{ id: "internal-tracker", manifest: pkg.armada, load: async () => ({ activate }) }];
const project = "orchard-2";
const request = {
  project,
  title: "Plant a tree",
  description: "Beside the river",
  labels: ["ready-for-agent", "planning"],
  actor: "Mira",
};

test("internal tickets survive edits, merged writes, duplicate comments and a restart without id collisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-internal-"));
  const options = {
    databasePath: join(directory, "events.sqlite"),
    configPath: join(directory, "config.json"),
    catalog,
    secrets: { get: async () => assert.fail("Internal tickets need no secrets") },
    log: { info() {}, error() {} },
  };
  let daemon = await bootDaemon(options);
  try {
    let tracker = daemon.registry.get("tracker", "internal")!;
    const [first, second] = await Promise.all([tracker.create!(request), tracker.create!(request)]);
    assert.deepEqual([first.id, second.id], ["ORCHA-1", "ORCHA-2"]);
    assert.equal((await tracker.create!({ ...request, project: "other" })).id, "OTHER-1");
    await tracker.update!({
      project,
      ticket: first.id,
      patch: { title: "Plant an oak", blockers: [second.id], source: "SEED-4", url: "https://example.test/seed/4" },
      actor: "Ivo",
    });
    await tracker.write({
      project,
      ticket: first.id,
      phase: "implementing",
      comment: "Working",
      commentId: "work",
      actor: "worker",
    });
    const fence: string[] = [];
    const unsubscribe = daemon.store.subscribe(() => fence.push("commit"));
    await tracker.write({
      project,
      ticket: first.id,
      phase: "merged",
      state: "completed",
      comment: "Merged",
      commentId: "merge",
      actor: "Mira",
      beforeWrite: () => fence.push("fence"),
    });
    unsubscribe();
    assert.deepEqual(fence, ["fence", "commit", "fence", "commit"]);
    await tracker.write({ project, ticket: first.id, comment: "Merged again", commentId: "merge", actor: "Ivo" });
    daemon.store.append({
      project,
      kind: "ticket.seen",
      at: "2030-01-01T00:00:00Z",
      actor: "Linear",
      payload: { id: first.id, title: "Stale external title", status: "unstarted" },
    });
    const tables = daemon.store.fold(project).projects[project]!;
    assert.deepEqual(tables.sessions, [], "ticket phase labels do not fabricate worker sessions");
    assert.equal(tables.tickets[0]?.title, "Plant an oak");
    assert.equal(tables.tickets[0]?.status, "completed");
    assert.equal(tables.tickets[0]?.phase, "merged");
    assert.deepEqual(tables.tickets[0]?.labels, ["ready-for-agent", "merged"]);
    assert.deepEqual(tables.tickets[0]?.blockers, [{ id: second.id, status: "backlog" }]);
    assert.deepEqual(
      tables.tickets[0]?.comments?.map((c) => [c.body, c.author]),
      [
        ["Merged", "Mira"],
        ["Working", "worker"],
      ],
    );
    assert.equal(tables.tickets[0]?.source, "SEED-4");
    assert.equal(tables.tickets[0]?.url, "https://example.test/seed/4");
    await tracker.update!({ project, ticket: second.id, patch: { state: "completed" } });
    assert.deepEqual(daemon.store.fold(project).projects[project]?.tickets[0]?.blockers, [
      { id: second.id, status: "completed" },
    ]);
    const history = daemon.store.readSince(0);
    assert.deepEqual(fold(history).projects[project], daemon.store.fold(project).projects[project]);
    assert.equal(
      daemon.store.history(project, first.id).some((e) => e.kind === "ticket.created"),
      true,
    );
    daemon.close();
    daemon = await bootDaemon(options);
    tracker = daemon.registry.get("tracker", "internal")!;
    assert.equal((await tracker.create!(request)).id, "ORCHA-3");
    for (let i = 0; i < 14; i++)
      await tracker.write({ project, ticket: first.id, comment: `Update ${i}`, commentId: `update-${i}` });
    const before = daemon.store.count;
    await tracker.write({ project, ticket: first.id, comment: "Old retry", commentId: "work" });
    assert.equal(daemon.store.count, before, "a comment id stays idempotent after leaving the visible last 12");
    const comments = daemon.store.fold(project).projects[project]!.tickets[0]!.comments!;
    assert.equal(comments.length, 12);
    assert.deepEqual(
      comments.map((c) => c.body),
      Array.from({ length: 12 }, (_, i) => `Update ${13 - i}`),
    );
    // Replay must deduplicate even externally appended duplicates and trust the envelope actor.
    const original = history.find((e) => e.kind === "ticket.commented")!;
    daemon.store.append({
      ...original,
      actor: "other",
      payload: { ...original.payload, author: "forged" },
    } as typeof original);
    assert.deepEqual(daemon.store.fold(project).projects[project]!.tickets[0]!.comments, comments);
    daemon.store.append({
      project,
      kind: "ticket.commented",
      at: "2099-01-01T00:00:00Z",
      actor: "Ivo",
      payload: { ticket: first.id, id: "envelope-author", body: "Owner note", author: "forged" },
    });
    assert.equal(daemon.store.fold(project).projects[project]?.tickets[0]?.comments?.[0]?.author, "Ivo");
    daemon.store.append({
      project,
      kind: "ticket.commented",
      at: "2099-01-01T01:00:00+05:00",
      actor: "Mira",
      payload: { ticket: first.id, id: "offset-note", body: "Earlier note", author: "Mira" },
    });
    assert.deepEqual(
      daemon.store
        .fold(project)
        .projects[project]?.tickets[0]?.comments?.slice(0, 2)
        .map((c) => c.body),
      ["Owner note", "Earlier note"],
    );
  } finally {
    daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fences, aborts and malformed requests leave the log unchanged; successful no-op reads advance freshness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-internal-"));
  const daemon = await bootDaemon({
    databasePath: ":memory:",
    configPath: join(directory, "config.json"),
    catalog,
    secrets: { get: async () => null },
    log: { info() {}, error() {} },
  });
  try {
    const tracker = daemon.registry.get("tracker", "internal")!;
    const { id } = await tracker.create!(request);
    daemon.store.append({
      project,
      kind: "ticket.seen",
      at: "2030-01-01T00:00:00Z",
      actor: "Linear",
      payload: { id: "SEEN-1", title: "External ticket", status: "started" },
    });
    assert.equal(
      daemon.store.fold(project).projects[project]?.tickets.find((t) => t.id === "SEEN-1")?.title,
      "External ticket",
    );
    const before = daemon.store.count;
    for (const action of [
      () => tracker.write({ project, ticket: id, phase: "nonsense" }),
      () =>
        tracker.write({
          project,
          ticket: id,
          comment: "no",
          beforeWrite: () => {
            throw new Error("fenced");
          },
        }),
      () => tracker.create!({ ...request, signal: AbortSignal.abort() }),
      () => tracker.update!({ project, ticket: "missing", patch: { title: "no" } }),
      () => tracker.update!({ project, ticket: "SEEN-1", patch: { title: "no" } }),
      () => tracker.write({ project, ticket: "SEEN-1", phase: "implementing" }),
      () => tracker.write({ project, ticket: "SEEN-1", comment: "no" }),
    ])
      await assert.rejects(action);
    assert.equal(daemon.store.count, before);
    let now = "2030-01-01T10:00:00.000Z";
    const readers = await startReaders({
      registry: daemon.registry,
      store: daemon.store,
      projects: [{ id: project, name: "Orchard", repository: "example/orchard", tracker: "internal" }],
      now: () => now,
      schedule: () => () => {},
    });
    try {
      await readers.ready;
      assert.equal(daemon.store.fold(project).projects[project]?.readAt?.internal, now);
      now = "2030-01-01T11:00:00.000Z";
      await readers.refresh(project);
      assert.equal(daemon.store.fold(project).projects[project]?.readAt?.internal, now);
      assert.equal(readers.readers[0]?.tracker, true);
    } finally {
      readers.stop();
    }
  } finally {
    daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the optional transaction capability leaves legacy event hosts usable and refuses unsafe mutations", async () => {
  let tracker: TrackerProvider | undefined;
  activate({
    config: {},
    events: { append: async () => assert.fail("No non-atomic writes"), read: async () => [], fold: async () => ({}) },
    secrets: { get: async () => assert.fail("No secrets") },
    register: {
      tracker: (_kind: string, provider: TrackerProvider) => {
        tracker = provider;
      },
    },
    log: { info() {}, error() {} },
  } as unknown as PluginContext);
  assert.ok(tracker?.create);
  await tracker.read({ project });
  await assert.rejects(() => tracker!.create!(request), /requires atomic event append support/);
});
