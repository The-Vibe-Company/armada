import { expect, test } from "bun:test";
import { rowOnlyDatabase } from "../../test/row-only-database.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "../retention-maintenance.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import type { LaneFactory } from "../server-worker-modules.ts";
import { sqlOver } from "../sql.ts";
import { runtimeWakes } from "../wake-bus.ts";
import { createJobsRunner } from "./runner.ts";
import { createJobsStore, JOBS_WAKE } from "./store.ts";

const database = rowOnlyDatabase();
const signal = new AbortController().signal;

async function fixture() {
  const { db, people } = await database();
  const sql = sqlOver({
    unsafe: async (query, params) => (await db.query(query, params)).rows,
    begin: (work) =>
      db.transaction((tx) => work({ unsafe: async (query, params) => (await tx.query(query, params)).rows })),
  });
  return { db, people, sql, store: createJobsStore(sql, btoa("\0".repeat(32))) };
}

test("transactional enqueue wakes after commit and replays the encrypted job by key", async () => {
  const { sql, people, store } = await fixture();
  const payload = { operation: "sample" };
  const enqueue = (tx = sql) =>
    store.enqueue("sample", null, null, "event", payload, { orgId: people.org, maxAttempts: 1 }, tx);
  let wakes = 0;
  const close = runtimeWakes.subscribe(JOBS_WAKE, () => wakes++);
  try {
    const id = await sql.transaction!(async (tx) => {
      const inserted = await enqueue(scopedRuntimeSql(tx));
      expect(wakes).toBe(0);
      return inserted;
    });
    expect(await enqueue()).toBe(id);
    expect(wakes).toBe(1);
    let delivered: unknown;
    const runner = createJobsRunner(store, {
      sample: {
        concurrency: 1,
        async run(job) {
          delivered = job.payload;
          return { status: "done" };
        },
      },
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(delivered).toEqual(payload);
    expect((await sql.query("select state from public.jobs where id = $1", [id])).rows).toEqual([{ state: "done" }]);
  } finally {
    close();
  }
});

test.each([1, 2])("a stale lifecycle lease is retired from claim generation %i", async (generation) => {
  const { db, people, store } = await fixture();
  const {
    rows: [golden],
  } = await db.query<{ id: string }>("select id from goldens where owner_id = $1", [people.owner]);
  const sandboxId = crypto.randomUUID();
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status, lifecycle_generation)
     values ($1, 'fixture', $2, $3, $4, 'codex', 'ready', 2)`,
    [sandboxId, golden!.id, people.org, people.owner],
  );
  const options = { orgId: people.org, maxAttempts: 2, deadline: new Date("2100-01-01") };
  const id = await store.enqueue("stop", sandboxId, generation, "old", null, options);
  let invoked = false;
  const runner = createJobsRunner(store, {
    stop: {
      concurrency: 1,
      async run() {
        invoked = true;
        await db.query("delete from sandboxes where id = $1", [sandboxId]);
        return { status: "done" };
      },
    },
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(invoked).toBe(generation === 2);
  expect((await db.query("select state, outcome from jobs where id = $1", [id])).rows).toEqual([
    { state: "failed", outcome: { reason: "stale_generation" } },
  ]);
});

test("internal enqueue scopes the same key to each sandbox incarnation", async () => {
  const { people, store } = await fixture();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const enqueue = (id: string, generation: number) =>
    store.enqueue("sample", id, generation, "event", null, { orgId: people.org, maxAttempts: 1 });
  const ids = await Promise.all([enqueue(first, 1), enqueue(first, 2), enqueue(second, 1)]);
  expect(new Set(ids).size).toBe(3);
});

test("a failed completion transaction replays the same job and preserves its prior evidence", async () => {
  const { db, people, store } = await fixture();
  const id = await store.enqueue("sample", null, null, "event", null, { orgId: people.org, maxAttempts: 1 });
  const evidence = { phase: "observed" };
  await db.query("update jobs set outcome = $2 where id = $1", [id, evidence]);
  const effects = new Set<string>();
  const epochs: string[] = [];
  const run: Parameters<typeof createJobsRunner>[1][string]["run"] = async (job, { canDispatch }) => {
    expect(await canDispatch()).toBe(job.attempts === 1);
    effects.add(job.id);
    epochs.push(job.lease_epoch);
    if (job.attempts === 1)
      return {
        status: "done",
        commit: async () => {
          throw new Error("Crash before commit.");
        },
      };
    return { status: "fail", reason: "reconciled" };
  };
  const runner = () => createJobsRunner(store, { sample: { concurrency: 1, run } }, () => {});
  const first = runner();
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
  const successor = runner();
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(epochs).toEqual(["1", "2"]);
  expect([...effects]).toEqual([id]);
  expect((await db.query("select state, outcome from jobs where id = $1", [id])).rows).toEqual([
    { state: "failed", outcome: { reason: "reconciled", evidence } },
  ]);
});

test("the registered jobs lane retries a lost seed reply and preserves the schedule across a restart", async () => {
  const { db, sql, store } = await fixture();
  await import("../modules.ts");
  const { jobsModule } = await import("../server-worker-modules.ts");
  const managed = new Map<string, LaneFactory>();
  jobsModule({ workers: { managed } } as Parameters<typeof jobsModule>[0]);
  const factory = managed.get("jobs")!;
  let purges = 0;
  let loseReply = true;
  const services = {
    jobs: {
      ...store,
      async enqueue(...args: Parameters<typeof store.enqueue>) {
        const id = await store.enqueue(...args);
        if (loseReply) {
          loseReply = false;
          throw new Error("Seed reply lost.");
        }
        return id;
      },
    },
    options: {},
    sql,
    control: {
      applicationVault: {
        async purgeExpired() {
          purges++;
        },
      },
    },
  } as Parameters<LaneFactory>[0];
  const lane = factory(services)!;
  await expect(lane.reconcileOne(signal)).rejects.toThrow("Seed reply lost.");
  expect(await lane.reconcileOne(signal)).toBe(true);
  await lane.drain();
  const restarted = factory(services)!;
  expect(await restarted.reconcileOne(signal)).toBe(false);
  expect(purges).toBe(1);
  const { rows } = await db.query(
    "select state, attempts, run_after > clock_timestamp() as delayed from jobs where kind = 'maintenance'",
  );
  expect(rows).toEqual([{ state: "queued", attempts: 0, delayed: true }]);
});

test("a failed recurring completion rolls back its schedule and the next lease replays the sweep", async () => {
  const { db, sql, store } = await fixture();
  const id = await seedRetentionMaintenance(store);
  const time = new Date("2100-01-01T00:00:00Z");
  let purges = 0;
  const handler = retentionMaintenanceJob(
    sql,
    {
      async purgeExpired() {
        purges++;
      },
    },
    () => {},
    () => time,
  );
  let retryExpiredCompletion: (() => Promise<boolean>) | undefined;
  const crashed = createJobsRunner(
    {
      ...store,
      complete(job, owner, result) {
        retryExpiredCompletion = () => store.complete(job, owner, result);
        return store.complete(job, owner, {
          ...result,
          async commit() {
            throw new Error("Completion interrupted before commit.");
          },
        });
      },
    },
    { maintenance: handler },
    () => {},
  );
  expect(await crashed.reconcileOne(signal)).toBe(true);
  await crashed.drain();
  expect((await db.query("select state, attempts from jobs where id = $1", [id])).rows).toEqual([
    { state: "leased", attempts: 1 },
  ]);
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
  expect(await retryExpiredCompletion?.()).toBe(false);
  const successor = createJobsRunner(store, { maintenance: handler });
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(purges).toBe(2);
  expect((await db.query("select state, attempts, run_after from jobs where id = $1", [id])).rows).toEqual([
    { state: "queued", attempts: 0, run_after: new Date(time.getTime() + 600_000) },
  ]);
});
