import { expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { ModalMachineOptions } from "@armada/provider-modal";
import { rowOnlyDatabase } from "../../test/row-only-database.ts";
import { createTurnDispatchJob, type DispatchTurn } from "../account-turn-dispatch.ts";
import { createAccountTurnQueue } from "../account-turn-queue.ts";
import { retentionMaintenanceJob, seedRetentionMaintenance } from "../retention-maintenance.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import type { LaneFactory } from "../server-worker-modules.ts";
import { sqlOver } from "../sql.ts";
import { runtimeWakes } from "../wake-bus.ts";
import { dispatchModalLaunch } from "./modal-launch.ts";
import { createJobsRunner, type Job } from "./runner.ts";
import { createJobsStore, JOBS_WAKE, withJobLease } from "./store.ts";

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

async function sandbox({ db, people }: Awaited<ReturnType<typeof fixture>>, boatRuntime = false, stopped = false) {
  const {
    rows: [golden],
  } = await db.query<{ id: string }>("select id from goldens where owner_id = $1", [people.owner]);
  const id = crypto.randomUUID();
  await db.query(
    `insert into sandboxes (id, boat_id, golden_id, org_id, owner_id, harness, status, lifecycle_generation, expires_at, boat_runtime, stopped_at)
     values ($1, $1::uuid::text, $2, $3, $4, 'codex',
       case when $6 then 'stopped'::sandbox_status else 'ready'::sandbox_status end, 2, 'infinity', $5,
       case when $6 then now() end)`,
    [id, golden!.id, people.org, people.owner, boatRuntime, stopped],
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

test("a replacement launch claimant reads Modal create intent and fences the previous writer", async () => {
  const f = await fixture();
  const id = await sandbox(f);
  const encryptionKey = btoa("\0".repeat(32));
  const jobId = await f.store.enqueue("launch", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  const owner = crypto.randomUUID();
  const first = (await f.store.claim("launch", owner, 30, 1))!;
  const journal = f.store.modalLaunchJournal(first);
  const intent = { operation: "create", phase: "creating", revision: 1, intent: "fixture" } as const;
  const receipt = { ...intent, phase: "allocated", revision: 2, machineId: "machine" } as const;
  expect(await journal.read("machine-key")).toBeUndefined();
  expect(await journal.compareAndSet("machine-key", undefined, intent)).toBe(true);
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);

  const restarted = createJobsStore(f.sql, encryptionKey);
  const successorOwner = crypto.randomUUID();
  const successor = (await restarted.claim("launch", successorOwner, 30, 1))!;
  const resumed = restarted.modalLaunchJournal(successor);
  expect(await resumed.read("machine-key")).toEqual(intent);
  await expect(journal.read("machine-key")).rejects.toThrow("claim is no longer current");
  expect(await journal.compareAndSet("machine-key", 1, receipt)).toBe(false);
  expect(await resumed.compareAndSet("different-key", 1, receipt)).toBe(false);
  expect(await resumed.compareAndSet("machine-key", 1, receipt)).toBe(true);
  expect(await resumed.compareAndSet("machine-key", 1, { ...receipt, machineId: "other" })).toBe(false);
  expect(
    await restarted.complete(successor, successorOwner, {
      status: "retry",
      after: new Date(0),
      outcome: { reason: "waiting_for_enrolment" },
    }),
  ).toBe(true);
  const retried = restarted.modalLaunchJournal((await restarted.claim("launch", crypto.randomUUID(), 30, 1))!);
  expect(await retried.read("machine-key")).toEqual(receipt);
  await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [id]);
  await expect(retried.read("machine-key")).rejects.toThrow("claim is no longer current");
  expect(await retried.compareAndSet("machine-key", 2, { ...receipt, revision: 3 })).toBe(false);
});

async function unboundModalSandbox(f: Awaited<ReturnType<typeof fixture>>) {
  const goldenId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into goldens (id, org_id, owner_id, name, visibility, provider, modal_workspace, modal_environment, modal_app_id)
     values ($1, $2, $3, 'modal-launch', 'private', 'modal', 'workspace', 'main', 'ap-test')`,
    [goldenId, f.people.org, f.people.owner],
  );
  await f.db.query(
    `insert into sandboxes (id, golden_id, org_id, owner_id, harness, provider, status, lifecycle_generation, runtime_transport)
     values ($1, $2, $3, $4, 'codex', 'modal', 'starting', 2, 'dialout')`,
    [id, goldenId, f.people.org, f.people.owner],
  );
  return id;
}

test("an unbound Modal launch can publish only its leased allocation receipt", async () => {
  const f = await fixture();
  const id = await unboundModalSandbox(f);
  const bind = (tx: Sql, machineId: string) =>
    tx.query("update sandboxes set provider_sandbox_id=$2 where id=$1 returning provider_sandbox_id", [id, machineId]);
  await expect(bind(f.sql, "guessed")).rejects.toMatchObject({ code: "23514" });
  await expect(f.sql.query("update sandboxes set status='ready' where id=$1", [id])).rejects.toMatchObject({
    code: "23514",
  });

  const jobId = await f.store.enqueue("launch", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  const original = (await f.store.claim("launch", crypto.randomUUID(), 30, 1))!;
  expect(
    await f.store.modalLaunchJournal(original).compareAndSet("machine-key", undefined, {
      operation: "create",
      phase: "allocated",
      intent: "fixture",
      revision: 1,
      machineId: "allocated",
    }),
  ).toBe(true);
  await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);
  await expect(bind(f.sql, "allocated")).rejects.toMatchObject({ code: "23514" });

  const successor = (await f.store.claim("launch", crypto.randomUUID(), 30, 1))!;
  expect(await withJobLease(f.sql, original, (tx) => bind(tx, "allocated"))).toBeUndefined();
  await expect(withJobLease(f.sql, successor, (tx) => bind(tx, "guessed"))).rejects.toMatchObject({ code: "23514" });
  const result = await withJobLease(f.sql, successor, (tx) => bind(tx, "allocated"));
  expect(result?.rows).toEqual([{ provider_sandbox_id: "allocated" }]);
  await expect(withJobLease(f.sql, successor, (tx) => bind(tx, "guessed"))).rejects.toMatchObject({ code: "23514" });
});

type ModalLaunchStep = "create response" | "bootstrap dispatch" | "image lookup" | "runtime ticket";

async function modalLaunchFixture() {
  const f = await fixture();
  const id = await unboundModalSandbox(f);
  const jobId = await f.store.enqueue("launch", id, 2, id, null, {
    orgId: f.people.org,
    maxAttempts: 3,
    deadline: new Date("2100-01-01T00:00:00Z"),
    request: { ownerId: f.people.owner, digest: "fixture" },
  });
  let allocations = 0;
  let observed = 0;
  let tags: Record<string, string> = {};
  const bootstrapped: string[] = [];
  const makeRunner = (atStep?: (step: ModalLaunchStep) => void | Promise<void>) => {
    const sandbox = {
      sandboxId: "physical",
      getTags: async () => tags,
      poll: async () => {
        observed++;
        return null;
      },
      async exec() {
        await atStep?.("bootstrap dispatch");
        const { rows } = await f.db.query<{ provider_sandbox_id: string }>(
          "select provider_sandbox_id from sandboxes where id=$1",
          [id],
        );
        bootstrapped.push(rows[0]!.provider_sandbox_id);
        return { stdin: { writeText: async () => {}, close: async () => {} }, wait: async () => 0 };
      },
    };
    const client = {
      apps: { fromName: async () => ({ appId: "ap-test" }) },
      images: {
        async fromId() {
          await atStep?.("image lookup");
          return { imageId: "image" };
        },
      },
      sandboxes: {
        async create(_app: unknown, _image: unknown, options: { tags: Record<string, string> }) {
          allocations++;
          tags = options.tags;
          await atStep?.("create response");
          return sandbox;
        },
        fromName: async () => sandbox,
        fromId: async () => sandbox,
      },
    } as unknown as ModalMachineOptions["client"];
    return createJobsRunner(
      createJobsStore(f.sql),
      {
        launch: {
          concurrency: 1,
          async run(job, context) {
            const outcome = await dispatchModalLaunch(f.sql, job, context, {
              allocation: { source: { kind: "image", ref: "image" }, size: null, computeTtlSeconds: 600 },
              bindingRef: job.id,
              machine: {
                client,
                appName: "test",
                binding: { appId: "ap-test", workspace: "workspace", environment: "main" },
                deploymentId: "deployment",
                async resolveRuntimeTicket() {
                  await atStep?.("runtime ticket");
                  return {
                    serverUrl: "https://armada.invalid",
                    artifact: { sha256: "a".repeat(64), bytes: 1 },
                    cacheDir: "/home/user/runtime-cache",
                    enrolmentToken: `armada_enrol_${"b".repeat(64)}`,
                  };
                },
                prepareCheckpoint: async () => {},
              },
            });
            if (outcome.kind !== "bootstrapped") throw new Error("Expected bootstrap");
            return { status: "done" };
          },
        },
      },
      () => {},
      () => () => {},
    );
  };
  return { f, id, jobId, makeRunner, effects: () => ({ allocations, observed, bootstrapped }) };
}

test.each(["create response", "bootstrap dispatch"] as const)(
  "a replacement Modal launch runner completes after losing the %s",
  async (failure) => {
    const { f, jobId, makeRunner, effects } = await modalLaunchFixture();
    const first = makeRunner((step) => {
      if (step === failure) throw new Error("Lost worker");
    });
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual([]);
    expect((await f.db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "leased" }]);
    await f.db.query("update jobs set lease_until='-infinity' where id=$1", [jobId]);

    const successor = makeRunner();
    expect(await successor.reconcileOne(signal)).toBe(true);
    await successor.drain();
    expect(effects().allocations).toBe(1);
    expect(effects().bootstrapped).toEqual(["physical"]);
    if (failure === "create response") expect(effects().observed).toBe(1);
    expect(
      (
        await f.db.query("select s.status, j.state from sandboxes s join jobs j on j.sandbox_id=s.id where j.id=$1", [
          jobId,
        ])
      ).rows,
    ).toEqual([{ status: "starting", state: "done" }]);
  },
);

test.each(["image lookup", "runtime ticket"] as const)(
  "a Modal launch whose job deadline expires during %s cannot dispatch the prepared operation",
  async (expiredAt) => {
    const { f, jobId, makeRunner, effects } = await modalLaunchFixture();
    const runner = makeRunner(async (step) => {
      if (step === expiredAt) await f.db.query("update jobs set deadline_at='-infinity' where id=$1", [jobId]);
    });
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(expiredAt === "image lookup" ? 0 : 1);
    expect(effects().bootstrapped).toEqual([]);
  },
);

test.each(["expiry", "revoked membership"] as const)(
  "a Modal job cannot allocate compute after sandbox %s",
  async (revokedBy) => {
    const { f, id, makeRunner, effects } = await modalLaunchFixture();
    if (revokedBy === "expiry") await f.db.query("update sandboxes set expires_at='-infinity' where id=$1", [id]);
    else await f.db.query("delete from members where org_id=$1 and user_id=$2", [f.people.org, f.people.owner]);
    const runner = makeRunner();
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(effects().allocations).toBe(0);
  },
);

async function turnFixture() {
  const f = await fixture();
  const key = btoa("\0".repeat(32));
  const queue = createAccountTurnQueue(f.sql, key);
  const caller = { userId: f.people.owner, via: "service", orgs: [{ orgId: f.people.org, role: "member" }] } as const;
  const accept = async (id: string) => {
    await f.db.query("update sandboxes set credential_id=$2,credential_version=1 where id=$1", [
      id,
      f.openaiCredentialId,
    ]);
    const request = crypto.randomUUID();
    expect(
      await queue.accept({ ...caller, orgs: [...caller.orgs] }, { id, request_id: request, prompt: "queued" }),
    ).toMatchObject({ status: "queued" });
    return request;
  };
  const retryAt = new Date("2100-01-01T00:00:01Z");
  const runnerFor = (send: DispatchTurn, store = f.store, dispatchSql = f.sql) =>
    createJobsRunner(
      store,
      { turn_dispatch: createTurnDispatchJob(dispatchSql, key, send, () => retryAt.getTime() - 1_000) },
      () => {},
      () => () => {},
    );
  return {
    ...f,
    queue,
    caller: { ...caller, orgs: [...caller.orgs] },
    accept,
    retryAt,
    runnerFor,
    async makeDue(sandboxId: string) {
      await f.db.query("update jobs set run_after='-infinity' where sandbox_id=$1", [sandboxId]);
    },
  };
}

function queueLockRefusalSql(f: Awaited<ReturnType<typeof fixture>>, phase: "admission" | "completion") {
  return sqlOver({
    unsafe: async (query, params) => (await f.db.query(query, params)).rows,
    begin: (work) =>
      f.db.transaction((tx) => {
        let completing = false;
        return work({
          async unsafe(query, params) {
            if (query.startsWith("select public.complete_job(")) completing = true;
            if (query.startsWith("lock table public.account_turn_queue") && (phase === "admission" || completing))
              throw Object.assign(new Error("Model repair holds the queue lock"), { code: "55P03" });
            return (await tx.query(query, params)).rows;
          },
        });
      }),
  });
}

test("shared turn admission defers without spending an attempt during model repair", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  await f.accept(id);
  const sent: string[] = [];
  const send: DispatchTurn = async (_caller, input) => sent.push(input.id);
  const runner = f.runnerFor(send, f.store, queueLockRefusalSql(f, "admission"));
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect(
    (
      await f.db.query(
        `select q.state as receipt, j.state as job, j.attempts,
                exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
         from account_turn_queue q join jobs j using (sandbox_id) where q.sandbox_id=$1`,
        [id],
      )
    ).rows,
  ).toEqual([{ receipt: "queued", job: "queued", attempts: 0, reserved: false }]);

  await f.makeDue(id);
  const successor = f.runnerFor(send);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(sent).toEqual([id]);
});

test.each(["deadline", "attempts"] as const)(
  "the turn handler settles receipts after exhausting %s",
  async (budget) => {
    const f = await turnFixture();
    const id = await sandbox(f, true);
    const request = await f.accept(id);
    const uncertain = budget === "attempts";
    if (uncertain) {
      await f.db.query(
        "update account_turn_queue set state='dispatching', dispatch_generation=2, dispatch_until='infinity' where sandbox_id=$1",
        [id],
      );
      await f.db.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
        id,
        f.openaiCredentialId,
      ]);
      await f.db.query("update jobs set attempts=max_attempts where sandbox_id=$1", [id]);
    } else {
      await f.db.query("update jobs set deadline_at='-infinity' where sandbox_id=$1", [id]);
    }
    const sent: string[] = [];
    const send: DispatchTurn = async (_caller, input) => sent.push(input.id);
    const runner = f.runnerFor(send);
    if (uncertain) {
      const repair = createJobsStore(queueLockRefusalSql(f, "completion"), btoa("\0".repeat(32)));
      const contended = f.runnerFor(send, repair);
      expect(await contended.reconcileOne(signal)).toBe(true);
      await contended.drain();
      expect(
        (
          await f.db.query(
            "select j.state as job, q.state as receipt from jobs j join account_turn_queue q using (sandbox_id) where j.sandbox_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ job: "leased", receipt: "dispatching" }]);
      await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [id]);
    }
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(sent).toEqual([]);
    expect(
      (
        await f.db.query(
          `select j.state as job, q.state as receipt, q.failure_reason,
           exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
         from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id
         where j.sandbox_id=$1 and q.request_id=$2`,
          [id, request],
        )
      ).rows,
    ).toEqual([
      {
        job: "failed",
        receipt: "failed",
        failure_reason: uncertain
          ? "Dispatch outcome uncertain; inspect sandbox history before resending."
          : "Queued prompt could not start before its dispatch budget expired.",
        reserved: uncertain,
      },
    ]);
  },
);

test("the turn handler waits for FIFO and capacity without spending its dispatch budget", async () => {
  const f = await turnFixture();
  const occupied = await sandbox(f);
  const first = await sandbox(f);
  const later = await sandbox(f);
  await f.db.query("update credentials set max_agents=1 where id=$1", [f.openaiCredentialId]);
  const firstRequest = await f.accept(first);
  const laterRequest = await f.accept(later);
  await expect(f.queue.accept(f.caller, { id: first, request_id: firstRequest, prompt: "changed" })).rejects.toThrow(
    "identical input",
  );
  await f.makeDue(later);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    const promptId = `actual_${input.request_id}`;
    await f.db.query("update sandboxes set status='running',task_prompt_id=$2 where id=$1", [input.id, promptId]);
    return { promptId, status: "running" };
  });
  const tick = async () => {
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
  };
  await tick();
  expect(sent).toEqual([]);
  await f.db.query("update sandboxes set status='running',task_prompt_id='active_turn',credential_id=$2 where id=$1", [
    occupied,
    f.openaiCredentialId,
  ]);
  for (let wait = 0; wait < 4; wait++) {
    await f.makeDue(first);
    await tick();
  }
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, state, run_after from jobs")).rows).toEqual([
    { attempts: 0, state: "queued", run_after: f.retryAt },
    { attempts: 0, state: "queued", run_after: f.retryAt },
  ]);
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [
    occupied,
  ]);
  await f.makeDue(first);
  await tick();
  await f.makeDue(later);
  await tick();
  expect(sent).toEqual([first]);
  expect(await f.queue.status(f.caller, first)).toEqual({
    nativePromptId: `actual_${firstRequest}`,
    publicPromptId: firstRequest,
  });
  expect(await f.queue.status(f.caller, first, firstRequest)).toEqual({ nativePromptId: `actual_${firstRequest}` });
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,$2,true)", [
    first,
    `actual_${firstRequest}`,
  ]);
  await f.makeDue(later);
  await tick();
  expect(sent).toEqual([first, later]);
  expect(await f.queue.status(f.caller, later, laterRequest)).toEqual({ nativePromptId: `actual_${laterRequest}` });
});

test.each(["unsettled prompt", "revoked actor"] as const)("the turn handler respects %s", async (condition) => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  if (condition === "unsettled prompt")
    await f.db.query("update sandboxes set task_prompt_id='active_turn' where id=$1", [id]);
  else
    await f.db.query("update mcp_actor_epochs set epoch=epoch+1 where org_id=$1 and user_id=$2", [
      f.people.org,
      f.people.owner,
    ]);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select sandbox_id from account_agent_reservations")).rows).toEqual([]);
  if (condition === "revoked actor") {
    expect(await f.queue.status(f.caller, id, request)).toMatchObject({ failed: true });
  } else {
    await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [
      id,
    ]);
    await f.makeDue(id);
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect(sent).toEqual([id]);
    expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
  }
});

test("interrupted turn deferral leaves the claim available to a successor after expiry", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  await f.db.query("update sandboxes set task_prompt_id='active_turn' where id=$1", [id]);
  const interrupted = createJobsStore(
    {
      ...f.sql,
      transaction: (work) =>
        f.sql.transaction!(async (tx: Sql) => {
          await work(tx);
          throw new Error("Connection lost before deferral commit.");
        }),
    },
    btoa("\0".repeat(32)),
  );
  const sent: string[] = [];
  const send: DispatchTurn = async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  };
  const first = f.runnerFor(send, { ...f.store, complete: interrupted.complete });
  expect(await first.reconcileOne(signal)).toBe(true);
  await first.drain();
  expect((await f.db.query("select state, attempts from jobs")).rows).toEqual([{ state: "leased", attempts: 1 }]);
  await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [id]);
  await f.db.query("insert into runtime_idle_turns(sandbox_id,prompt_id,settled) values($1,'active_turn',true)", [id]);
  const successor = f.runnerFor(send);
  expect(await successor.reconcileOne(signal)).toBe(true);
  await successor.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test("the turn handler defers an open dispatch window and recovers after it expires", async () => {
  const f = await turnFixture();
  const id = await sandbox(f, true);
  const request = await f.accept(id);
  await f.db.query(
    `update account_turn_queue set state='dispatching',dispatch_generation=queued_generation,
       dispatch_until='infinity' where sandbox_id=$1`,
    [id],
  );
  await f.db.query("insert into account_agent_reservations(sandbox_id,account_id) values($1,$2)", [
    id,
    f.openaiCredentialId,
  ]);
  const sent: string[] = [];
  const runner = f.runnerFor(async (_caller, input) => {
    sent.push(input.id);
    return { promptId: input.request_id, status: "running" };
  });
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, state from jobs")).rows).toEqual([{ attempts: 0, state: "queued" }]);
  await f.db.query("update account_turn_queue set dispatch_until='-infinity' where sandbox_id=$1", [id]);
  await f.makeDue(id);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test("a generation change before turn admission retargets the job without charging an attempt", async () => {
  const f = await turnFixture();
  const id = await sandbox(f);
  const request = await f.accept(id);
  let advanced = false;
  const sent: string[] = [];
  const runner = f.runnerFor(
    async (_caller, input) => {
      sent.push(input.id);
      return { promptId: input.request_id, status: "running" };
    },
    {
      ...f.store,
      async inspect(job, owner, tx) {
        const state = await f.store.inspect(job, owner, tx);
        if (state === "dispatch" && !advanced) {
          advanced = true;
          await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [id]);
        }
        return state;
      },
    },
  );
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([]);
  expect((await f.db.query("select attempts, generation::text, state from jobs")).rows).toEqual([
    { attempts: 0, generation: "3", state: "queued" },
  ]);
  expect(await runner.reconcileOne(signal)).toBe(true);
  await runner.drain();
  expect(sent).toEqual([id]);
  expect(await f.queue.status(f.caller, id, request)).toEqual({ nativePromptId: request });
});

test.each([
  "queued",
  "native evidence",
  "runtime evidence",
  "current native evidence",
  "current runtime evidence",
  "other request evidence",
  "dispatching",
  "stopped with queued",
  "stopped with queued dispatch evidence",
  "stopped with dispatching",
  "stopped after retarget",
  "wake-on-send",
  "failed",
  "admitted",
  "missing",
] as const)("a turn job reconciles a %s receipt at claim", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f, scenario === "dispatching");
  const requestId = crypto.randomUUID();
  if (scenario !== "missing") await seedTurn(f, sandboxId, requestId);
  const options = { orgId: people.org, maxAttempts: 2 };
  const enqueue = () => store.enqueue("turn_dispatch", sandboxId, 2, requestId, { requestId }, options);
  const id = await enqueue();
  const retargetedBeforeStop = scenario === "stopped after retarget";
  const cancelled =
    scenario === "stopped with queued" ||
    scenario === "stopped with queued dispatch evidence" ||
    scenario === "stopped with dispatching" ||
    retargetedBeforeStop;
  const stopped = cancelled || scenario === "wake-on-send";
  const nativeEvidence = scenario === "native evidence" || scenario === "current native evidence";
  const runtimeEvidence = scenario === "runtime evidence" || scenario === "current runtime evidence";
  const otherEvidence = scenario === "other request evidence";
  const currentGeneration = scenario === "wake-on-send" || scenario.startsWith("current") || otherEvidence;
  const exactEvidence = nativeEvidence || runtimeEvidence;
  const state =
    scenario === "stopped with dispatching" || scenario === "dispatching"
      ? "dispatching"
      : scenario === "failed" || scenario === "admitted"
        ? scenario
        : "queued";
  if (retargetedBeforeStop) await db.query("update jobs set generation=3 where id=$1", [id]);
  await db.query("update account_turn_queue set state=$1, native_prompt_id=$2 where sandbox_id=$3", [
    state,
    nativeEvidence ? "prior-prompt" : null,
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
        runtimeEvidence ? requestId : otherEvidence ? crypto.randomUUID() : null,
        runtimeEvidence || otherEvidence ? "infinity" : null,
        currentGeneration ? 2 : 3,
      ],
    );
  if (scenario === "stopped with queued dispatch evidence")
    await db.query("update sandboxes set task_prompt_id=$2 where id=$1", [sandboxId, requestId]);
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
  expect(delivered).toHaveLength(retargeted || scenario === "wake-on-send" || otherEvidence ? 1 : 0);
  if (retargeted) expect(delivered[0]).toMatchObject({ id, generation: "3", payload: { requestId } });
  expect((await db.query("select state, generation::text from jobs where id=$1", [id])).rows).toEqual([
    {
      state:
        retargeted ||
        scenario === "wake-on-send" ||
        otherEvidence ||
        scenario === "failed" ||
        scenario === "admitted" ||
        scenario === "missing"
          ? "done"
          : "failed",
      generation: retargeted || retargetedBeforeStop ? "3" : "2",
    },
  ]);
  if (cancelled || exactEvidence)
    expect(
      (await db.query("select state, failure_reason from account_turn_queue where request_id=$1", [requestId])).rows,
    ).toEqual([
      {
        state: "failed",
        failure_reason:
          scenario === "stopped with queued dispatch evidence" || exactEvidence
            ? "Queued receipt already has dispatch evidence; inspect sandbox history before resending."
            : state === "queued"
              ? "Queued prompt cannot start: sandbox stopped, deleted, expired, or stopping."
              : "Dispatch cancelled by confirmed stop.",
      },
    ]);
  expect(await enqueue()).toBe(id);
});

test.each([
  ["native generation changed", 3, null, "-infinity", false, true],
  ["native request started at the job generation", 2, "request", "-infinity", false, true],
  ["native request started without a legacy window", 2, "request", null, false, true],
  ["native legacy window still open", 2, "request", "infinity", false, false],
  ["runtime request started", 2, "request", "-infinity", true, false],
  ["runtime request advanced generation", 3, "request", "-infinity", true, false],
  ["runtime request already at dispatch generation", 3, "request", "-infinity", true, false],
  ["runtime request advanced after claim", 3, "request", "-infinity", true, false],
  ["runtime retarget interrupted before commit", 3, "request", "-infinity", true, false],
  ["runtime request advanced beyond dispatch generation", 4, "request", "-infinity", true, false],
  ["runtime request advanced with an open window", 3, "request", "infinity", true, false],
  ["different runtime request advanced generation", 3, "other", "-infinity", true, false],
  ["runtime command persisted", 2, "command", "-infinity", true, false],
  ["published runtime follow-up", 3, "command", "-infinity", true, false],
  ["unfinished runtime follow-up", 3, "command", "-infinity", true, false],
  ["older-epoch runtime follow-up", 3, "command", "-infinity", true, false],
  ["published runtime resume", 3, "resume", "infinity", true, false],
  ["unfinished enrolled runtime resume", 3, "resume", "infinity", true, false],
  ["unfinished unenrolled runtime resume", 3, "resume", "infinity", true, false],
  ["older-epoch runtime resume", 3, "resume", "infinity", true, false],
  ["unrelated runtime resume", 3, "resume", "-infinity", true, false],
  ["runtime legacy window still open", 2, null, "infinity", true, false],
  ["runtime dispatch has no evidence", 2, null, "-infinity", true, false],
  ["stopped runtime dispatch has no evidence", 2, null, "-infinity", true, false],
  ["older job for abandoned runtime dispatch", 3, null, "-infinity", true, false],
  ["native receipt has a prompt ID", 2, "prompt", "-infinity", false, true],
  ["native dispatch has no evidence", 2, null, "-infinity", false, false],
  ["older job for abandoned native dispatch", 3, null, "-infinity", false, false],
  ["native dispatch window is missing", 2, null, null, false, false],
  ["native reset interrupted before commit", 2, null, "-infinity", false, false],
] as const)("shared claim reconciles %s", async (scenario, generation, activity, until, runtime, uncertain) => {
  const f = await fixture();
  const { db, people, store } = f;
  const sandboxId = await sandbox(f, runtime, scenario === "stopped runtime dispatch has no evidence");
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
  await db.query(
    `update account_turn_queue set state='dispatching', dispatch_generation=$4, dispatch_until=$2,
       native_prompt_id=$3 where request_id=$1`,
    [
      requestId,
      until,
      activity === "prompt" ? "prior-prompt" : null,
      scenario.startsWith("older job") || scenario === "runtime request already at dispatch generation" ? 3 : 2,
    ],
  );
  const pendingWake = activity === "resume" && scenario.startsWith("unfinished");
  await db.query(`update sandboxes set lifecycle_generation=$2, activity_lease_id=$3, activity_until=$4 where id=$1`, [
    sandboxId,
    scenario === "runtime request advanced after claim" ? 2 : generation,
    activity === "request" || pendingWake ? requestId : activity === "other" ? crypto.randomUUID() : null,
    activity === "request" || activity === "other" || pendingWake ? "infinity" : null,
  ]);
  await db.query("insert into account_agent_reservations (sandbox_id, account_id) values ($1, $2)", [
    sandboxId,
    f.openaiCredentialId,
  ]);
  if (activity === "command") {
    const finished = scenario === "published runtime follow-up" || scenario === "older-epoch runtime follow-up";
    if (generation === 3)
      await db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
         values ($1,$2,$3,repeat('a',64))`,
        [sandboxId, generation, scenario === "older-epoch runtime follow-up" ? 2 : 1],
      );
    await db.query(
      `insert into runtime_commands (sandbox_id, request_id, epoch, request_enc, result_enc)
       values ($1,$2,1,''::bytea,case when $3 then ''::bytea end)`,
      [sandboxId, `follow_${requestId}`, finished],
    );
  }
  if (activity === "resume") {
    const finished = !pendingWake;
    await db.query(
      `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
       values ($1,$2,$3,case when $4 then repeat('a',64) end)`,
      [
        sandboxId,
        generation,
        scenario === "older-epoch runtime resume" ? 3 : 2,
        scenario !== "unfinished unenrolled runtime resume",
      ],
    );
    await db.query(
      `insert into runtime_resumes (sandbox_id,request_id,source_epoch,target_epoch,watermark,request_hash,
         conversation_id,model,reasoning_effort,phase,verified_at,receipt)
       values ($1,$2,1,2,0,repeat('a',64),'fixture','fixture','low',
         case when $3 then 'complete' else 'dispatched' end,
         case when $3 then now() end,case when $3 then '{"resumed":true}'::jsonb end)`,
      [sandboxId, scenario === "unrelated runtime resume" ? crypto.randomUUID() : requestId, finished],
    );
  }
  const outcome = async () =>
    (
      await db.query(
        `select j.state as job_state, q.state as receipt_state, q.failure_reason,
              (q.dispatch_generation is not null or q.dispatch_until is not null) as dispatch_recorded,
              exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
       from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where j.id=$1`,
        [id],
      )
    ).rows;
  const interrupted = scenario.endsWith("interrupted before commit");
  if (interrupted) {
    const faultySql = sqlOver({
      unsafe: async (query, params) => (await db.query(query, params)).rows,
      begin: (work) =>
        db.transaction(async (tx) => {
          await work({ unsafe: async (query, params) => (await tx.query(query, params)).rows });
          throw new Error("Interrupted before reconciliation commit.");
        }),
    });
    await expect(
      createJobsStore(faultySql, btoa("\0".repeat(32))).claim("turn_dispatch", crypto.randomUUID(), 30, 1),
    ).rejects.toThrow("Interrupted before reconciliation commit.");
    expect(await outcome()).toEqual([
      {
        job_state: "leased",
        receipt_state: "dispatching",
        failure_reason: null,
        dispatch_recorded: true,
        reserved: true,
      },
    ]);
    expect((await db.query("select generation::text from jobs where id=$1", [id])).rows).toEqual([{ generation: "2" }]);
    await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
  }
  const owner = crypto.randomUUID();
  let claim = await store.claim("turn_dispatch", owner, 30, 1);
  if (scenario === "runtime request advanced after claim") {
    await db.query("update sandboxes set lifecycle_generation=$2 where id=$1", [sandboxId, generation]);
    expect(await store.inspect(claim!, owner)).toBe("stale");
    await store.retireStale(claim!, owner, "no_dispatch");
    claim = await store.claim("turn_dispatch", owner, 30, 1);
    expect(claim?.attempts).toBe(1);
  }
  const reset =
    (interrupted && !runtime) || scenario.endsWith("dispatch has no evidence") || scenario.startsWith("older job");
  expect(await outcome()).toEqual([
    {
      job_state: uncertain ? "failed" : "leased",
      receipt_state: uncertain ? "failed" : reset ? "queued" : "dispatching",
      failure_reason: uncertain ? "Dispatch outcome uncertain; inspect sandbox history before resending." : null,
      dispatch_recorded: !reset,
      reserved: !reset,
    },
  ]);
  if (
    reset ||
    scenario === "published runtime follow-up" ||
    scenario === "published runtime resume" ||
    scenario === "unfinished enrolled runtime resume" ||
    scenario === "runtime request advanced generation" ||
    scenario === "runtime request already at dispatch generation" ||
    scenario === "runtime request advanced after claim" ||
    (interrupted && runtime)
  ) {
    expect(claim).toMatchObject({ id, generation: String(generation), payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe("dispatch");
  } else if (runtime && generation > 2) {
    expect(await store.inspect(claim!, owner)).toBe("stale");
  }
});

async function interruptedDockerTurn(
  status: "starting" | "running" | "stopped",
  existingFixture?: Awaited<ReturnType<typeof fixture>>,
) {
  const f = existingFixture ?? (await fixture());
  const { db, people, store } = f;
  const sandboxId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const dockerGeneration = crypto.randomUUID();
  await db.query(
    `insert into docker_hosts (id,org_id,owner_id,installation_id,hash,registration_expires_at)
       values ($1,$2,$3,$4,repeat('a',64),'-infinity')`,
    [hostId, people.org, people.owner, installationId],
  );
  await db.query(
    `insert into sandboxes (id,org_id,owner_id,harness,status,provider,lifecycle_generation,expires_at,
         visibility,access_owner_id,docker_host_id,docker_installation_id,docker_generation,docker_image,provider_sandbox_id,stopped_at)
       values ($1,$2,$3,'codex',$8::public.sandbox_status,'docker',$9,'infinity',
         'private',$3,$4,$5,$6,'sha256:' || repeat('b',64),$7,case when $8::public.sandbox_status='stopped' then now() end)`,
    [
      sandboxId,
      people.org,
      people.owner,
      hostId,
      installationId,
      dockerGeneration,
      `armada-${installationId}-${hostId}-${sandboxId}-${dockerGeneration}`,
      status,
      status === "stopped" ? 2 : 3,
    ],
  );
  await seedTurn(f, sandboxId, requestId);
  const id = await store.enqueue(
    "turn_dispatch",
    sandboxId,
    2,
    requestId,
    { requestId },
    { orgId: people.org, maxAttempts: 2 },
  );
  await db.query(
    `update account_turn_queue set state='dispatching',dispatch_generation=2,dispatch_until='-infinity'
       where sandbox_id=$1 and request_id=$2`,
    [sandboxId, requestId],
  );
  await db.query("insert into account_agent_reservations (sandbox_id,account_id) values ($1,$2)", [
    sandboxId,
    f.openaiCredentialId,
  ]);
  return { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id };
}

test.each(["missing", "pending", "accepted", "refused", "unrelated"] as const)(
  "stopped Docker dispatch resets only without its own bootstrap intent (%s)",
  async (intent) => {
    const { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id } =
      await interruptedDockerTurn("stopped");
    const { db, people, store } = f;
    if (intent !== "missing")
      await db.query(
        `insert into docker_resume_claims
         (request_id,sandbox_id,host_id,installation_id,generation,actor_id,lifecycle_generation,accepted)
         values ($1,$2,$3,$4,$5,$6,2,$7)`,
        [
          intent === "unrelated" ? crypto.randomUUID() : requestId,
          sandboxId,
          hostId,
          installationId,
          dockerGeneration,
          people.owner,
          intent === "pending" ? null : intent === "accepted",
        ],
      );
    const owner = crypto.randomUUID();
    const claim = await store.claim("turn_dispatch", owner, 30, 1);
    expect(claim).toMatchObject({ id, generation: "2", payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe("dispatch");
    const reset = intent === "missing" || intent === "unrelated";
    expect(
      (
        await db.query(
          `select q.state, (q.dispatch_generation is not null or q.dispatch_until is not null) as dispatch_recorded,
             exists(select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id) as reserved
             from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: reset ? "queued" : "dispatching", dispatch_recorded: !reset, reserved: !reset }]);
  },
);

test.each(["current", "pending", "other request", "other epoch", "old issuer", "revoked host"] as const)(
  "a Docker prompt command can retarget a stale turn only with current replay evidence (%s)",
  async (evidence) => {
    const { f, sandboxId, requestId, hostId, id } = await interruptedDockerTurn("running");
    const { db, people, store } = f;
    await db.query(
      `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash,docker_issuer_fence)
       select $1,3,2,repeat('c',64),user_id::text || ':' || (epoch + $4::bigint)::text
       from mcp_actor_epochs where org_id=$2 and user_id=$3`,
      [sandboxId, people.org, people.owner, evidence === "old issuer" ? -1 : 0],
    );
    await db.query(
      `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
       values ($1,$2,$3,''::bytea,case when $4 then ''::bytea end)`,
      [
        sandboxId,
        `docker_prompt_${evidence === "other request" ? crypto.randomUUID() : requestId}`,
        evidence === "other epoch" ? 1 : 2,
        evidence !== "pending",
      ],
    );

    if (evidence === "revoked host") await db.query("update docker_hosts set revoked_at=now() where id=$1", [hostId]);

    const owner = crypto.randomUUID();
    const claim = await store.claim("turn_dispatch", owner, 30, 1);
    const recoverable = evidence === "current" || evidence === "pending";
    expect(claim).toMatchObject({ id, generation: recoverable ? "3" : "2", payload: { requestId } });
    expect(await store.inspect(claim!, owner)).toBe(recoverable ? "dispatch" : "stale");
    expect(
      (
        await db.query(
          `select q.state, exists(
             select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id and r.account_id=q.account_id
           ) as reserved from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: "dispatching", reserved: true }]);
  },
);

test.each([
  ["pending while starting", "starting", null, true],
  ["pending after readiness", "running", null, false],
  ["completed before prompt", "running", "completed", true],
  ["failed", "starting", "failed", false],
  ["refused", "starting", null, false],
  ["revoked host", "starting", null, false],
  ["unrelated request", "starting", null, false],
  ["old actor epoch", "starting", null, false],
  ["old source generation", "starting", null, false],
  ["physical claim pending", "starting", null, false],
  ["prompt already submitted", "running", "completed", false],
] as const)(
  "a stale turn resumes only from its live Docker host job (%s)",
  async (scenario, status, outcome, recover) => {
    const { f, sandboxId, requestId, hostId, installationId, dockerGeneration, id } =
      await interruptedDockerTurn(status);
    const { db, people, store } = f;
    const resumeId = scenario === "unrelated request" ? crypto.randomUUID() : requestId;
    await db.query(
      `insert into docker_resume_claims
       (request_id,sandbox_id,host_id,installation_id,generation,actor_id,lifecycle_generation,accepted)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        resumeId,
        sandboxId,
        hostId,
        installationId,
        dockerGeneration,
        people.owner,
        scenario === "old source generation" ? 1 : 2,
        scenario === "physical claim pending" ? null : true,
      ],
    );
    await db.query(
      `insert into docker_host_jobs
       (request_id,host_id,input_enc,bound_sandbox_id,bound_actor_id,bound_actor_epoch,bound_operation,
        outcome,completed_at,refused_resume_generation)
     select $1,$2,decode(repeat('00',29),'hex'),$3,$4,epoch + $5::bigint,'resume',$6,
       case when $6::text is not null then now() end, $7
     from mcp_actor_epochs where org_id=$8 and user_id=$4`,
      [
        resumeId,
        hostId,
        sandboxId,
        people.owner,
        scenario === "old actor epoch" ? -1 : 0,
        outcome,
        scenario === "refused" ? 3 : null,
        people.org,
      ],
    );
    if (scenario === "revoked host") await db.query("update docker_hosts set revoked_at=now() where id=$1", [hostId]);
    if (scenario === "prompt already submitted") {
      await db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc) values ($1,$2,1,''::bytea)`,
        [sandboxId, `docker_prompt_${requestId}`],
      );
    }
    if (recover) {
      await db.query("update account_turn_queue set dispatch_until='2100-01-01T00:00:00Z' where request_id=$1", [
        requestId,
      ]);
      const owner = crypto.randomUUID();
      const stale = (await store.claim("turn_dispatch", owner, 30, 1))!;
      expect(await store.inspect(stale, owner)).toBe("stale");
      const interrupted = createJobsStore(
        {
          ...f.sql,
          transaction: (work) =>
            f.sql.transaction!(async (tx) => {
              await work(tx);
              throw new Error("Connection lost before Docker resume deferral committed.");
            }),
        },
        btoa("\0".repeat(32)),
      );
      await expect(interrupted.retireStale(stale, owner, "no_dispatch")).rejects.toThrow("Connection lost");
      expect(await store.inspect(stale, owner)).toBe("stale");
      await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);

      const successor = crypto.randomUUID();
      const claim = (await store.claim("turn_dispatch", successor, 30, 1))!;
      await store.retireStale(claim, successor, "no_dispatch");
      expect(
        (
          await db.query(
            `select j.state, j.attempts, j.generation::text, j.lease_owner,
                    (j.run_after=q.dispatch_until) as waits_for_receipt
             from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id
             where j.id=$1 and q.request_id=$2`,
            [id, requestId],
          )
        ).rows,
      ).toEqual([{ state: "queued", attempts: 1, generation: "2", lease_owner: null, waits_for_receipt: true }]);
      expect(await store.claim("turn_dispatch", crypto.randomUUID(), 30, 1)).toBeFalsy();
      await db.query("update account_turn_queue set dispatch_until='-infinity' where request_id=$1", [requestId]);
      await db.query("update jobs set run_after='-infinity' where id=$1", [id]);
    }
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    expect(job).toMatchObject({ id, generation: recover ? "3" : "2", payload: { requestId } });
    expect(await store.inspect(job, owner)).toBe(recover ? "dispatch" : "stale");
    if (scenario === "pending after readiness") await store.retireStale(job, owner, "no_dispatch");
    expect(
      (
        await db.query(
          `select q.state, exists(select 1 from account_agent_reservations r
      where r.sandbox_id=q.sandbox_id and r.account_id=q.account_id) as reserved
     from account_turn_queue q where q.sandbox_id=$1 and q.request_id=$2`,
          [sandboxId, requestId],
        )
      ).rows,
    ).toEqual([{ state: "dispatching", reserved: true }]);
  },
);

test.each([
  ["unsupported queued state", "queued", "starting", 2, "infinity", false, false],
  ["stop intent", "queued", "ready", 2, "infinity", true, false],
  ["expiry", "queued", "running", 2, "-infinity", false, false],
  ["failed sandbox", "dispatching", "failed", 2, "infinity", false, false],
  ["deleted sandbox", "dispatching", "deleted", 2, "infinity", false, false],
  ["stopping after claim", "dispatching", "stopping", 3, "infinity", false, true],
] as const)(
  "a turn lease settles the receipt after %s",
  async (_scenario, state, status, generation, expiry, stopRequested, afterClaim) => {
    const f = await fixture();
    const { db, people, store } = f;
    const sandboxId = await sandbox(f);
    const requestId = crypto.randomUUID();
    await seedTurn(f, sandboxId, requestId);
    await db.query(
      "update account_turn_queue set state=$2, dispatch_generation=case when $2='dispatching' then 2 end where request_id=$1",
      [requestId, state],
    );
    const jobId = await store.enqueue(
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
    const changeSandbox = () =>
      db.query(
        `update sandboxes set status=$2, lifecycle_generation=$3, expires_at=$4,
           stop_requested_at=case when $5 then now() end,
           deleted_at=case when $6 then now() end where id=$1`,
        [sandboxId, status, generation, expiry, stopRequested, status === "deleted"],
      );
    if (!afterClaim) await changeSandbox();
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    if (afterClaim) {
      await changeSandbox();
      expect(await store.inspect(job, owner)).toBe("stale");
      await store.retireStale(job, owner, "no_dispatch");
    }
    expect(await store.inspect(job, owner)).toBe("lost");
    expect((await db.query("select state from jobs where id=$1", [jobId])).rows).toEqual([{ state: "failed" }]);
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
  },
);

test.each([
  "confirmed stop",
  "superseded dispatch",
  "missing dispatch generation",
  "expired adjacent dispatch without evidence",
  "expired adjacent dispatch with unrelated activity",
  "expired adjacent dispatch with an obsolete runtime command",
  "adjacent dispatch without a deadline or evidence",
] as const)("a failed receipt write rolls back retirement after %s", async (scenario) => {
  const f = await fixture();
  const { db, people, store } = f;
  const uncertain = scenario !== "confirmed stop";
  const sandboxId = await sandbox(f, uncertain);
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
  if (uncertain) {
    const missingDeadline = scenario === "adjacent dispatch without a deadline or evidence";
    const adjacent = missingDeadline || scenario.startsWith("expired adjacent");
    const activityId = scenario === "expired adjacent dispatch with unrelated activity" ? crypto.randomUUID() : null;
    await db.query(
      "update sandboxes set lifecycle_generation=$2, activity_lease_id=$3, activity_until=$4 where id=$1",
      [sandboxId, adjacent ? 3 : 4, activityId, activityId ? "infinity" : null],
    );
    await db.query(
      "update account_turn_queue set state='dispatching', dispatch_generation=$2, dispatch_until=$3 where request_id=$1",
      [
        requestId,
        scenario === "missing dispatch generation" ? null : 2,
        missingDeadline ? null : adjacent ? "-infinity" : "infinity",
      ],
    );
    if (scenario === "expired adjacent dispatch with an obsolete runtime command") {
      await db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash)
         values ($1,3,2,repeat('a',64))`,
        [sandboxId],
      );
      await db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc,result_enc)
         values ($1,$2,1,''::bytea,''::bytea)`,
        [sandboxId, `follow_${requestId}`],
      );
    }
    await db.query("insert into account_agent_reservations (sandbox_id, account_id) values ($1, $2)", [
      sandboxId,
      f.openaiCredentialId,
    ]);
  } else {
    await db.query("update sandboxes set lifecycle_generation=3, status='stopped', stopped_at=now() where id=$1", [
      sandboxId,
    ]);
  }
  const claimAndRetire = async () => {
    const owner = crypto.randomUUID();
    const job = (await store.claim("turn_dispatch", owner, 30, 1))!;
    if ((await store.inspect(job, owner)) === "stale") await store.retireStale(job, owner, "no_dispatch");
  };
  await db.exec("alter table account_turn_queue add constraint reject_failure check (state <> 'failed')");
  try {
    await expect(claimAndRetire()).rejects.toThrow("reject_failure");
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
  expect(await states()).toEqual([{ job: "leased", receipt: uncertain ? "dispatching" : "queued" }]);
  await db.query("update jobs set lease_until='-infinity' where id=$1", [id]);
  await claimAndRetire();
  expect(await states()).toEqual([{ job: "failed", receipt: "failed" }]);
  if (uncertain) {
    expect(
      (
        await db.query(
          `select q.failure_reason, q.dispatch_until, exists(
         select 1 from account_agent_reservations r where r.sandbox_id=q.sandbox_id
       ) as reserved from account_turn_queue q where q.request_id=$1`,
          [requestId],
        )
      ).rows,
    ).toEqual([
      {
        failure_reason: "Dispatch outcome uncertain; inspect sandbox history before resending.",
        dispatch_until: null,
        reserved: true,
      },
    ]);
  }
});

test.each(["boat", "docker", "docker with a current prompt"] as const)(
  "a stale %s turn preserves its open dispatch window across an interrupted requeue",
  async (provider) => {
    const f = await turnFixture();
    const setup = async () => {
      const sandboxId = await sandbox(f, true);
      const requestId = await f.accept(sandboxId);
      await f.db.query("update sandboxes set lifecycle_generation=3 where id=$1", [sandboxId]);
      return { sandboxId, requestId };
    };
    const { sandboxId, requestId } = provider === "boat" ? await setup() : await interruptedDockerTurn("running", f);
    const currentPrompt = provider === "docker with a current prompt";
    if (currentPrompt) {
      await f.db.query(
        `insert into runtime_enrolments (sandbox_id,lifecycle_generation,epoch,runtime_hash,docker_issuer_fence)
         select $1,3,2,repeat('c',64),user_id::text || ':' || epoch::text
         from mcp_actor_epochs where org_id=$2 and user_id=$3`,
        [sandboxId, f.people.org, f.people.owner],
      );
      await f.db.query(
        `insert into runtime_commands (sandbox_id,request_id,epoch,request_enc)
         values ($1,$2,2,''::bytea)`,
        [sandboxId, `docker_prompt_${requestId}`],
      );
    }
    await f.makeDue(sandboxId);
    await f.db.query(
      `update account_turn_queue set state='dispatching', dispatch_generation=2, dispatch_until='2100-01-01T00:00:00Z'
     where request_id=$1`,
      [requestId],
    );
    let dispatches = 0;
    const send: DispatchTurn = async () => {
      dispatches++;
      throw new Error("Stale receipt must not dispatch");
    };
    const interrupted = createJobsStore(
      {
        ...f.sql,
        transaction: (work) =>
          f.sql.transaction!(async (tx) => {
            await work(tx);
            throw new Error("Connection lost before stale turn requeue commit.");
          }),
      },
      btoa("\0".repeat(32)),
    );
    const state = () =>
      f.db.query(
        `select j.state as job, q.state as receipt, j.attempts, j.generation::text,
              (j.run_after=q.dispatch_until) as waits_for_receipt
       from jobs j join account_turn_queue q on q.sandbox_id=j.sandbox_id where q.request_id=$1`,
        [requestId],
      );
    const first = f.runnerFor(send, { ...f.store, retireStale: interrupted.retireStale });
    expect(await first.reconcileOne(signal)).toBe(true);
    await first.drain();
    expect((await state()).rows).toEqual([
      { job: "leased", receipt: "dispatching", attempts: 1, generation: "2", waits_for_receipt: false },
    ]);
    await f.db.query("update jobs set lease_until='-infinity' where sandbox_id=$1", [sandboxId]);

    const runner = f.runnerFor(send);
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect((await state()).rows).toEqual([
      { job: "queued", receipt: "dispatching", attempts: 1, generation: "2", waits_for_receipt: true },
    ]);
    expect(await runner.reconcileOne(signal)).toBe(false);
    await f.db.query("update account_turn_queue set dispatch_until='-infinity' where request_id=$1", [requestId]);
    await f.makeDue(sandboxId);
    if (currentPrompt) {
      const owner = crypto.randomUUID();
      const claim = await f.store.claim("turn_dispatch", owner, 30, 1);
      expect(claim).toMatchObject({ generation: "3", payload: { requestId } });
      expect(await f.store.inspect(claim!, owner)).toBe("dispatch");
      expect(dispatches).toBe(0);
      return;
    }
    expect(await runner.reconcileOne(signal)).toBe(true);
    await runner.drain();
    expect((await state()).rows).toEqual([
      { job: "failed", receipt: "failed", attempts: 2, generation: "2", waits_for_receipt: null },
    ]);
    expect(dispatches).toBe(0);
  },
);

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
  const sandboxId = await sandbox(f, true);
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
