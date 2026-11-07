import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  armadaApi,
  fleetClient,
  HAND_BACK_SCHEMA,
  type HandBackRef,
  type ReportRecord,
  serveFleet,
} from "@armada/core/read";
import type { Database } from "../lib/db.ts";
import { consumeHandBack, fleetStore, handBackState, recordHandBack } from "../lib/fleet-store.ts";
import { scalar, tempDatabase } from "./support.ts";

let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
}, 30_000);
afterAll(async () => {
  await db?.end();
});
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40),
  M = "d".repeat(40);
let sequence = 0;
async function fixture() {
  const project = `hb-${++sequence}`,
    ticket = "DEMO-7",
    store = fleetStore(db);
  await store.ensureProject(
    { slug: project, name: "Synthetic", repository: "example/widgets", programRoot: "DEMO-1" },
    at(0),
  );
  await store.saveRuntimeHandle({
    project,
    ticket,
    runtime: "conductor",
    handle: "synthetic/work",
    branch: "feature/demo-7",
    at: at(0),
  });
  const state = await handBackState(db, project, ticket);
  expect(state.claimGeneration).toMatch(/^[a-f0-9]{64}$/);
  const report = (pr = 10, sha = A, previous: HandBackRef | null = null): ReportRecord => ({
    ticket,
    phase: "ready-to-merge",
    previous: "implementing",
    summary: `PR #${pr}, head ${sha}, CI green`,
    message: "",
    prUrl: `https://github.com/example/widgets/pull/${pr}`,
    headSha: sha,
    handBack: { schema: HAND_BACK_SCHEMA, claimGeneration: state.claimGeneration!, previous },
  });
  const put = (r = report(), n = 1) => recordHandBack(db, { project, report: r, at: at(n) });
  const consume = (
    ref: HandBackRef,
    keepOpen = true,
    mergedHeadSha = ref.headSha,
    lineage: { from: string; to: string } | null = null,
  ) =>
    consumeHandBack(db, {
      project,
      at: at(4),
      merge: {
        ticket,
        number: ref.pr,
        url: `https://github.com/example/widgets/pull/${ref.pr}`,
        headSha: mergedHeadSha,
        mergeCommit: M,
        keepOpen,
        handBackReceipt: { handBack: ref, mergedHeadSha, mergeCommit: M, verifiedMainLineage: lineage },
      },
    });
  const rows = () => handBackState(db, project, ticket);
  const events = () => scalar(db, "SELECT count(*) FROM events WHERE project = $1", [project]);
  return { project, ticket, store, report, put, consume, rows, events };
}
test("distinct-prs: two immutable revisions coexist", async () => {
  const f = await fixture(),
    first = await f.put(),
    second = await f.put(f.report(11, B), 2);
  expect(first.id).not.toBe(second.id);
  expect((await f.rows()).items.map((i) => i.handBack?.pr)).toEqual([10, 11]);
  expect(await f.events()).toBe(2);
});
test("same-pr-new-head: supersession preserves original body/author/time", async () => {
  const f = await fixture(),
    first = await f.put();
  const second = await f.put(f.report(10, B, first), 2);
  expect((await f.rows()).items.map((i) => i.id)).toEqual([second.id]);
  const old = await f.store.getInboxItem(f.project, first.id);
  expect(old).toMatchObject({
    body: first.body,
    author: first.author,
    createdAt: first.createdAt,
    resolution: "superseded",
  });
});
test("exact-duplicate: same pin and evidence returns same id/event count", async () => {
  const f = await fixture(),
    first = await f.put();
  expect((await f.put(f.report(), 2)).id).toBe(first.id);
  expect(await f.events()).toBe(1);
});
test("same-pin-different-body: no silent update", async () => {
  const f = await fixture(),
    first = await f.put();
  const r = f.report();
  r.summary += "; different evidence";
  await expect(f.put(r, 2)).rejects.toThrow("different evidence");
  expect((await f.rows()).items[0]?.body).toBe(first.body);
  expect(await f.events()).toBe(1);
});
test("resolve-one: partial receipt consumes only one sibling", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(11, B), 2);
  const out = await f.consume(a);
  expect(out.remainingHandBacks?.map((i) => i.id)).toEqual([b.id]);
  expect(out.aggregatePhase).toBe("ready-to-merge");
  expect((await f.rows()).items.map((i) => i.id)).toEqual([b.id]);
  expect((await f.store.getRuntimeHandle(f.project, f.ticket))?.releasedAt).toBeNull();
});
test("final-close-sibling: final receipt refuses without releasing the claim", async () => {
  const f = await fixture(),
    a = await f.put();
  await f.put(f.report(11, B), 2);
  await expect(f.consume(a, false)).rejects.toThrow("final closure refused");
  expect((await f.rows()).items).toHaveLength(2);
  expect(await f.events()).toBe(2);
});
test("unbound-head: new merged head needs verified native lineage", async () => {
  const f = await fixture(),
    a = await f.put();
  await expect(f.consume(a, true, B)).rejects.toThrow("not linked");
  expect((await f.rows()).items[0]?.id).toBe(a.id);
});
test("report-summary-mismatch: PR and SHA declaration must agree", async () => {
  const f = await fixture();
  await f.put();
  const r = f.report(11, B);
  r.summary = `PR #12, head ${B}, CI green`;
  await expect(f.put(r, 2)).rejects.toThrow("summary disagrees");
  expect((await f.rows()).items).toHaveLength(1);
});
test("foreign-repository: registered repository is authoritative", async () => {
  const f = await fixture();
  await f.put();
  const r = f.report(11, B);
  r.prUrl = "https://github.com/foreign/widgets/pull/11";
  await expect(f.put(r, 2)).rejects.toThrow("registered repository");
  expect(await f.events()).toBe(1);
});
test("superseded-generation: a delayed old request cannot relabel a new claim", async () => {
  const f = await fixture(),
    a = await f.put();
  await f.store.saveRuntimeHandle({
    project: f.project,
    ticket: f.ticket,
    runtime: "conductor",
    handle: "synthetic/replacement",
    branch: null,
    at: at(2),
  });
  expect((await f.rows()).claimGeneration).not.toBe(a.claimGeneration);
  await expect(f.put(f.report(11, B), 3)).rejects.toThrow("generation");
  expect(await f.events()).toBe(1);
});
test("stale-report: old compare-and-supersede token cannot overwrite newer evidence", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(10, B, a), 2);
  await expect(f.put(f.report(10, C, a), 3)).rejects.toThrow("stale report");
  expect((await f.rows()).items[0]?.id).toBe(b.id);
});
test("ambiguous-open: database uniqueness prevents a second open revision of a PR", async () => {
  const f = await fixture(),
    a = await f.put();
  await expect(
    db.query(
      `INSERT INTO inbox_items(project,ticket,kind,recipient,author,body,created_at,hb_repository,hb_pr,hb_head_sha,hb_generation)
    SELECT project,ticket,kind,recipient,author,body,created_at,hb_repository,hb_pr,$2,hb_generation FROM inbox_items WHERE id=$1`,
      [a.id, B],
    ),
  ).rejects.toThrow();
  expect((await f.rows()).items).toHaveLength(1);
});
test("queue-pin-moved: new revision cannot silently rewrite an admitted entry", async () => {
  const f = await fixture(),
    a = await f.put();
  const e = {
    project: f.project,
    ticket: f.ticket,
    pr: 10,
    noTicket: false,
    keepOpen: true,
    throughHold: null,
    reason: "fixture",
    headSha: A,
    queuedBy: "synthetic",
    at: at(2),
    handBack: a,
  };
  await f.store.queueAdd(e);
  const before = await f.store.queueList(f.project, { since: at(0) });
  const b = await f.put(f.report(10, B, a), 3);
  await expect(f.store.queueAdd({ ...e, handBack: b, headSha: B, at: at(4) })).rejects.toThrow("preserved");
  expect(await f.store.queueList(f.project, { since: at(0) })).toEqual(before);
});
test("main-lineage: native-scoped lineage preserves original and merged heads", async () => {
  const f = await fixture(),
    a = await f.put();
  const out = await f.consume(a, true, B, { from: A, to: B });
  expect(out.resolved).toBe(1);
  const row = await db.query("SELECT receipt FROM hand_back_merge_receipts WHERE project=$1", [f.project]);
  expect(row.rows[0]?.receipt).toMatchObject({ handBack: { headSha: A }, mergedHeadSha: B });
});
test("lineage-wrong-pr: lineage from PR A does not authorize PR B", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(11, B), 2);
  await expect(f.consume({ ...a, pr: b.pr }, true, C, { from: A, to: C })).rejects.toThrow("identify");
  expect((await f.rows()).items).toHaveLength(2);
});
test("lost-response: exact merge receipt is idempotent after committed consumption", async () => {
  const f = await fixture(),
    a = await f.put();
  await f.put(f.report(11, B), 2);
  const first = await f.consume(a),
    count = await f.events();
  expect(await f.consume(a)).toEqual(first);
  expect(await f.events()).toBe(count);
  expect((await f.rows()).items).toHaveLength(1);
});
test("rollback: failed report event rolls back both supersession and new revision", async () => {
  const f = await fixture(),
    a = await f.put();
  const broken: Database = {
    ...db,
    query: db.query.bind(db),
    end: db.end.bind(db),
    connect: async () => {
      const connection = await db.connect();
      return {
        release: connection.release.bind(connection),
        query: async (sql, args) => {
          if (sql.includes("INSERT INTO events")) throw new Error("synthetic event failure");
          return connection.query(sql, args);
        },
      };
    },
  };
  await expect(recordHandBack(broken, { project: f.project, report: f.report(10, B, a), at: at(2) })).rejects.toThrow(
    "synthetic event failure",
  );
  expect((await f.rows()).items.map((i) => i.id)).toEqual([a.id]);
  expect(await f.events()).toBe(1);
});
test("concurrent-new-head: only one compare-and-supersede wins", async () => {
  const f = await fixture(),
    a = await f.put();
  const outcomes = await Promise.allSettled([f.put(f.report(10, B, a), 2), f.put(f.report(10, C, a), 3)]);
  expect(outcomes.filter((i) => i.status === "fulfilled")).toHaveLength(1);
  expect((await f.rows()).items).toHaveLength(1);
  expect(await f.events()).toBe(2);
}, 10_000);
test("concurrent-sibling-before-cleanup: fresh transaction catches a later sibling", async () => {
  const f = await fixture(),
    a = await f.put();
  expect((await f.rows()).items).toHaveLength(1); // coordinator's earlier preflight
  await f.put(f.report(11, B), 2);
  await expect(f.consume(a, false)).rejects.toThrow("final closure refused");
  expect((await f.rows()).items).toHaveLength(2);
});
test("legacy-unbound: old index/writers remain valid, never relabelled into v2", async () => {
  const f = await fixture();
  await f.store.putHandBack({
    project: f.project,
    ticket: f.ticket,
    author: "legacy",
    body: "legacy evidence",
    at: at(1),
  });
  await f.store.putHandBack({
    project: f.project,
    ticket: f.ticket,
    author: "legacy",
    body: "updated legacy evidence",
    at: at(2),
  });
  const before = (await f.rows()).items;
  expect(before).toHaveLength(1);
  expect(before[0]?.handBack).toBeUndefined();
  await expect(f.put(f.report(11, B), 3)).rejects.toThrow("legacy-unbound");
  expect((await f.rows()).items).toEqual(before);
});
test("fifo-preserved: two PR references retain order, flags and reasons", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(11, B), 2);
  for (const [i, ref] of [a, b].entries())
    await f.store.queueAdd({
      project: f.project,
      ticket: f.ticket,
      pr: ref.pr,
      noTicket: false,
      keepOpen: true,
      throughHold: null,
      reason: `reason-${i}`,
      headSha: ref.headSha,
      queuedBy: "synthetic",
      at: at(3 + i),
      handBack: ref,
    });
  const rows = await f.store.queueList(f.project, { since: at(0) });
  expect(rows.map((i) => [i.pr, i.reason, i.keepOpen, i.handBack?.id])).toEqual([
    [10, "reason-0", true, a.id],
    [11, "reason-1", true, b.id],
  ]);
});
test("legacy lease and first scoped admission exclude each other", async () => {
  const f = await fixture();
  expect(
    await f.store.acquireLease({ project: f.project, name: "merge-queue", holder: "old", ttlMs: 600000, at: at(0) }),
  ).toEqual({ acquired: true });
  await expect(f.put()).rejects.toThrow("legacy merge lease");
  expect(await f.events()).toBe(0);
  await f.store.releaseLease({ project: f.project, name: "merge-queue", holder: "old" });
  const a = await f.put();
  expect(a.id).toBeGreaterThan(0);
  await expect(
    f.store.acquireLease({ project: f.project, name: "merge", holder: "old", ttlMs: 600000, at: at(2) }),
  ).rejects.toThrow("legacy merge lease");
});

test("scoped correction closes one revision; an unscoped report preserves its sibling", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(11, B), 2);
  await f.store.resumeHandBack({
    project: f.project,
    at: at(3),
    report: { ...f.report(10, A, a), phase: "implementing", summary: "correcting this PR" },
  });
  expect((await f.rows()).items.map((i) => i.id)).toEqual([b.id]);
  await expect(
    f.store.resumeHandBack({
      project: f.project,
      at: at(4),
      report: {
        ...f.report(11, B, { ...b, claimGeneration: "0".repeat(64) }),
        phase: "implementing",
        summary: "stale",
      },
    }),
  ).rejects.toThrow("claim");
  expect((await f.rows()).items.map((i) => i.id)).toEqual([b.id]);
});
test("old partial receipt cannot reopen a later completed generation", async () => {
  const f = await fixture(),
    a = await f.put(),
    b = await f.put(f.report(11, B), 2);
  await f.consume(a);
  const final = await f.consume(b, false);
  expect(final.handle?.releasedAt).not.toBeNull();
  const replay = await f.consume(a);
  expect(replay.superseded).toBe(true);
  expect(replay.remainingHandBacks).toEqual([]);
  expect(replay.handle?.releasedAt).not.toBeNull();
});

test("final receipt remains repairable after its own release, but not a replacement claim", async () => {
  const f = await fixture(),
    a = await f.put();
  await f.consume(a, false);
  expect((await f.consume(a, false)).superseded).toBe(false);
  expect((await f.rows()).merges[0]?.superseded).toBe(false);
  await f.store.saveRuntimeHandle({
    project: f.project,
    ticket: f.ticket,
    runtime: "conductor",
    handle: "replacement",
    branch: null,
    at: at(5),
  });
  expect((await f.consume(a, false)).superseded).toBe(true);
  expect((await f.rows()).merges[0]?.superseded).toBe(true);
});
test("legacy writers remain excluded after the last partial receipt while its claim is active", async () => {
  const f = await fixture(),
    a = await f.put();
  await f.consume(a);
  expect((await f.rows()).items).toEqual([]);
  expect(await f.store.hasScopedHandBacks(f.project, f.ticket)).toBe(true);
  await expect(
    f.store.putHandBack({ project: f.project, ticket: f.ticket, author: "legacy", body: "overwrite", at: at(5) }),
  ).rejects.toThrow("legacy writer");
  await expect(
    f.store.acquireLease({ project: f.project, name: "merge", holder: "legacy", ttlMs: 600000, at: at(5) }),
  ).rejects.toThrow("legacy merge lease");
  const b = await f.put(f.report(11, B), 6);
  await f.consume(b, false);
  expect(await f.store.hasScopedHandBacks(f.project, f.ticket)).toBe(false);
});

test("expired legacy lease cannot renew after first v2 admission", async () => {
  const f = await fixture();
  await f.store.acquireLease({ project: f.project, name: "merge-queue", holder: "old", ttlMs: 1000, at: at(0) });
  await f.put();
  const before = await f.store.getLease(f.project, "merge-queue");
  await expect(
    f.store.renewLease({ project: f.project, name: "merge-queue", holder: "old", ttlMs: 600000, at: at(2) }),
  ).rejects.toThrow("legacy merge lease");
  expect(await f.store.getLease(f.project, "merge-queue")).toEqual(before);
});
test("lease acquisition racing first v2 report admits exactly one side", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.put(),
    f.store.acquireLease({ project: f.project, name: "merge-queue", holder: "old", ttlMs: 600000, at: at(1) }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rows = await f.rows(),
    lease = await f.store.getLease(f.project, "merge-queue");
  expect(rows.items.length === 1).toBe(!lease);
}, 10_000);

test("typed database binding rejects absent fields rather than SQL unknown", async () => {
  const f = await fixture();
  const a = await f.put();
  expect(a.id).toBeGreaterThan(0);
  for (const missing of ["hb_pr", "hb_head_sha", "hb_generation"]) {
    await expect(
      db.query(`UPDATE inbox_items SET ${missing}=NULL WHERE project=$1 AND id=$2`, [f.project, a.id]),
    ).rejects.toThrow("hand_back_v2_binding");
    expect((await f.rows()).items[0]?.handBack).toEqual({
      schema: a.schema,
      id: a.id,
      project: a.project,
      repository: a.repository,
      ticket: a.ticket,
      pr: a.pr,
      headSha: a.headSha,
      claimGeneration: a.claimGeneration,
    });
  }
});
