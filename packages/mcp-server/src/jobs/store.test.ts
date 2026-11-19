import { expect, test } from "bun:test";
import { rowOnlyDatabase } from "../../test/row-only-database.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "../retention-maintenance.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import type { LaneFactory } from "../server-worker-modules.ts";
import { sqlOver } from "../sql.ts";
import { runtimeWakes } from "../wake-bus.ts";
import { createJobsRunner, type Job } from "./runner.ts";
import { createJobsStore, JOBS_WAKE } from "./store.ts";

const database = rowOnlyDatabase();
const signal = new AbortController().signal;

async function fixture() {
  const { db, people, openaiCredentialId } = await database();
  const sql = sqlOver({
    unsafe: async (query, params) => (await db.query(query, params)).rows,
    begin: (work) =>
      db.transaction((tx) => work({ unsafe: async (query, params) => (await tx.query(query, params)).rows })),
  });
  return { db, people, openaiCredentialId, sql, store: createJobsStore(sql, btoa("\0".repeat(32))) };
}

async function sandbox({ db, people }: Awaited<ReturnType<typeof fixture>>) {
  const {
    rows: [golden],
  } = await db.query<{ id: string }>("select id from goldens where owner_id = $1", [people.owner]);
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status, lifecycle_generation, expires_at)
     values ($1, 'fixture', $2, $3, $4, 'codex', 'ready', 2, 'infinity')`,
    [id, golden!.id, people.org, people.owner],
  );
  return id;
}

async function seedTurn(f: Awaited<ReturnType<typeof fixture>>, sandboxId: string, requestId: string) {
  await f.db.query(
    `insert into account_turn_queue
       (sandbox_id,request_id,account_id,owner_id,org_id,actor_epoch,credential_version,
        input_hash,input_enc,conversation_id,queued_generation)
     values ($1,$2,$3,$4,$5,1,1,'fixture',''::bytea,'fixture',2)`,
    [sandboxId, requestId, f.openaiCredentialId, f.people.owner, f.people.org],
  );
}

test.each([
  "queued",
  "native evidence",
  "runtime evidence",
  "dispatching",
  "stopped with queued",
  "stopped with dispatching",
  "wake-on-send",
  "failed",
  "admitted",
  "missing",
] as const)("a turn job reconciles a %s receipt at claim", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  if (scenario !== "missing") await seedTurn(f, sandboxId, requestId);
  const options = { orgId: people.org, maxAttempts: 2 };
  const enqueue = () => store.enqueue("turn_dispatch", sandboxId, 2, requestId, { requestId }, options);
  const id = await enqueue();
  const cancelled = scenario === "stopped with queued" || scenario === "stopped with dispatching";
  const stopped = cancelled || scenario === "wake-on-send";
  const state =
    scenario === "stopped with dispatching" || scenario === "dispatching"
      ? "dispatching"
      : scenario === "failed" || scenario === "admitted"
        ? scenario
        : "queued";
  await db.query("update account_turn_queue set state=$1, native_prompt_id=$2 where sandbox_id=$3", [
    state,
    scenario === "native evidence" ? "prior-prompt" : null,
    sandboxId,
  ]);
  if (scenario !== "failed")
    await db.query(
      `update sandboxes set lifecycle_generation=$6, status=$2, stopped_at=$3,
           activity_lease_id=$4, activity_until=$5 where id=$1`,
      [
        sandboxId,
        stopped ? "stopped" : "ready",
        stopped ? "2026-01-01" : null,
        scenario === "runtime evidence" ? requestId : null,
        scenario === "runtime evidence" ? "infinity" : null,
        scenario === "wake-on-send" ? 2 : 3,
      ],
    );
  const delivered: Job[] = [];
  const runner = createJobsRunner(
    store,
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job) {
          delivered.push(job);
          return { status: "done" };
        },
      },
    },
    () => {},
    () => () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  const retargeted = scenario === "queued";
  expect(delivered).toHaveLength(retargeted || scenario === "wake-on-send" ? 1 : 0);
  if (retargeted) expect(delivered[0]).toMatchObject({ id, generation: "3", payload: { requestId } });
  expect((await db.query("select state, generation::text from jobs where id=$1", [id])).rows).toEqual([
    {
      state:
        retargeted ||
        scenario === "wake-on-send" ||
        scenario === "failed" ||
        scenario === "admitted" ||
        scenario === "missing"
          ? "done"
          : "failed",
      generation: retargeted ? "3" : "2",
    },
  ]);
  if (cancelled)
    expect(
      (await db.query("select state, failure_reason from account_turn_queue where request_id=$1", [requestId])).rows,
    ).toEqual([
      {
        state: "failed",
        failure_reason:
          state === "queued"
            ? "Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping."
            : "Dispatch cancelled by confirmed stop.",
      },
    ]);
  expect(await enqueue()).toBe(id);
});

test("a failed receipt write leaves the stopped turn recoverable by the next job lease", async () => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 2,
    },
  );
  await db.query("update sandboxes set lifecycle_generation=3, status='stopped', stopped_at=now() where id=$1", [
    sandboxId,
  ]);
  await db.exec("alter table account_turn_queue add constraint reject_failure check (state <> 'failed')");
  try {
    await expect(store.claim("turn_dispatch", crypto.randomUUID(), 30, 1)).rejects.toThrow("reject_failure");
  } finally {
    await db.exec("alter table account_turn_queue drop constraint reject_failure");
  }
  const states = async () =>
    (
      await db.query(
        "select j.state as job, q.state as receipt from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where j.id=$1",
        [id],
      )
    ).rows;
  expect(await states()).toEqual([{ job: "leased", receipt: "queued" }]);
  await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
  await store.claim("turn_dispatch", crypto.randomUUID(), 30, 1);
  expect(await states()).toEqual([{ job: "failed", receipt: "failed" }]);
});

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

test("a second generation advance before inspection requeues the same pending send", async () => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 1,
    },
  );
  await db.query("update sandboxes set lifecycle_generation=3 where id=$1", [sandboxId]);
  const dispatched: Job[] = [];
  const runner = createJobsRunner(
    {
      ...store,
      async inspect(job, owner) {
        if (job.generation === "3")
          await db.query("update sandboxes set lifecycle_generation=4 where id=$1", [sandboxId]);
        return store.inspect(job, owner);
      },
    },
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job, context) {
          if (await context.canDispatch()) dispatched.push(job);
          return { status: "done" };
        },
      },
    },
    () => {},
    () => () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(dispatched).toEqual([]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toMatchObject({ id, generation: "4", attempts: 1, payload: { requestId } });
});

test("receipt lock contention releases the claim without spending a dispatch attempt", async () => {
  const f = await fixture();
  const { db, people, sql, store } = f;
  const sandboxId = await sandbox(f);
  const requestId = crypto.randomUUID();
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    {
      orgId: people.org,
      maxAttempts: 1,
    },
  );
  const contended = createJobsStore(
    {
      ...sql,
      transaction: async () => {
        throw Object.assign(new Error("Receipt lock unavailable"), { code: "55P03" });
      },
    },
    btoa("\0".repeat(32)),
  );
  const owner = crypto.randomUUID();
  const job = (await contended.claim("turn_dispatch", owner, 30, 1))!;
  expect(await store.inspect(job, owner)).toBe("lost");
  expect(
    (await db.query("select state, attempts, run_after > created_at as delayed from jobs where id=$1", [id])).rows,
  ).toEqual([{ state: "queued", attempts: 0, delayed: true }]);
  await db.query("update jobs set run_after='-infinity' where id=$1", [id]);
  const successorOwner = crypto.randomUUID();
  const successor = (await store.claim("turn_dispatch", successorOwner, 30, 1))!;
  expect(await store.inspect(successor, successorOwner)).toBe("dispatch");
});

test.each([1, 2])("a stale lifecycle lease is retired from claim generation %i", async (generation) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
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

test.each([
  "complete",
  "takeover",
  "stale",
  "interrupted",
  "not advanced",
  "expired",
  "deadline",
  "prerequisites",
] as const)("turn admission generation handoff handles %s", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f);
  const request = crypto.randomUUID();
  const options = { orgId: people.org, maxAttempts: 2 };
  await seedTurn(f, sandboxId, request);
  const payload = { requestId: request };
  const id = await store.enqueue("turn_dispatch", sandboxId, 2, request, payload, options);
  const advance = "update sandboxes set lifecycle_generation = lifecycle_generation + 1 where id = $1";
  let firstOwner: string | undefined;
  let handled: Job | undefined;
  const runner = createJobsRunner(
    {
      ...store,
      claim(kind, owner, seconds, concurrency) {
        firstOwner = owner;
        return store.claim(kind, owner, seconds, concurrency);
      },
    },
    {
      turn_dispatch: {
        concurrency: 1,
        async run(job, context) {
          const handoff = context.handoffGeneration({
            async lockPrerequisites(tx) {
              if (scenario === "prerequisites")
                await tx.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
            },
            async advance(tx) {
              if (scenario === "not advanced") return;
              await tx.query("update account_turn_queue set state='dispatching' where sandbox_id=$1", [sandboxId]);
              await tx.query(advance, [sandboxId]);
              if (scenario === "interrupted") throw new Error("Admission interrupted.");
              if (scenario === "expired")
                await tx.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
              if (scenario === "deadline")
                await tx.query("update jobs set deadline_at = '-infinity' where id = $1", [id]);
            },
          });
          if (scenario === "interrupted") {
            await expect(handoff).rejects.toThrow("Admission interrupted.");
          } else if (scenario === "prerequisites") {
            await expect(handoff).rejects.toThrow("Turn job lease is no longer current.");
          } else if (scenario === "not advanced" || scenario === "expired" || scenario === "deadline") {
            await expect(handoff).rejects.toThrow("Turn admission did not advance its fenced generation.");
          } else {
            expect(await handoff).toBe("3");
            expect(await context.canDispatch()).toBe(true);
            expect(await store.renew(job, firstOwner!, 30)).toBe(true);
            if (scenario === "stale") await db.query(advance, [sandboxId]);
          }
          handled = job;
          if (scenario === "takeover") throw new Error("Receipt was not committed.");
          return { status: "done" };
        },
      },
    },
    () => {},
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(handled?.id).toBe(id);

  if (scenario === "takeover") {
    await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
    const owner = crypto.randomUUID();
    const successor = (await store.claim("turn_dispatch", owner, 30, 1))!;
    expect(successor).toMatchObject({ id, generation: "3", lease_epoch: "2" });
    expect(await store.complete(handled!, firstOwner!, { status: "done" })).toBe(false);
    expect(await store.complete(successor, owner, { status: "done" })).toBe(true);
    expect(await store.enqueue("turn_dispatch", sandboxId, 2, request, payload, options)).toBe(id);
  }
  const rolledBack = scenario !== "complete" && scenario !== "takeover" && scenario !== "stale";
  expect(
    (
      await db.query(
        `select j.state, j.generation::text as job_generation, s.lifecycle_generation::text as sandbox_generation
       from jobs j join sandboxes s on j.sandbox_id = s.id where j.id = $1`,
        [id],
      )
    ).rows,
  ).toEqual([
    {
      state: scenario === "stale" ? "failed" : "done",
      job_generation: rolledBack ? "2" : "3",
      sandbox_generation: rolledBack ? "2" : scenario === "stale" ? "4" : "3",
    },
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
  let seeds = 0;
  const services = {
    jobs: {
      ...store,
      async enqueue(...args: Parameters<typeof store.enqueue>) {
        const id = await store.enqueue(...args);
        if (++seeds === 1) {
          throw new Error("Seed reply lost.");
        }
        return id;
      },
    },
    options: { logError: () => {} },
    githubApp: null,
    config: {},
    langfuse: {
      exportJob: {
        concurrency: 1,
        async run() {
          throw new Error("Unexpected Langfuse export.");
        },
      },
    },
    webhooks: {
      run: async () => {
        throw new Error("Unexpected webhook.");
      },
    },
    outputs: { enqueueCaptures: async () => {}, drain: async () => {} },
    sql,
    control: {
      applicationVault: {
        async purgeExpired() {
          purges++;
        },
      },
    },
  } as unknown as Parameters<LaneFactory>[0];
  const lane = factory(services)!;
  expect(await lane.reconcileOne(signal)).toBe(true);
  await lane.drain();
  expect(await lane.reconcileOne(signal)).toBe(false);
  const restarted = factory(services)!;
  expect(await restarted.reconcileOne(signal)).toBe(false);
  expect(purges).toBe(1);
  expect(seeds).toBe(3);
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
          async commit(tx) {
            await result.commit?.(tx);
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
  const schedule = async () => (await db.query("select state, attempts, run_after from jobs where id = $1", [id])).rows;
  const beforeExpiry = await schedule();
  expect(beforeExpiry).toMatchObject([{ state: "leased", attempts: 1 }]);
  await db.query("update jobs set lease_until = '-infinity' where id = $1", [id]);
  expect(await retryExpiredCompletion?.()).toBe(false);
  expect(await schedule()).toEqual(beforeExpiry);
  const successor = createJobsRunner(store, { maintenance: handler });
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(purges).toBe(2);
  expect(await schedule()).toEqual([{ state: "queued", attempts: 0, run_after: new Date(time.getTime() + 600_000) }]);
});
