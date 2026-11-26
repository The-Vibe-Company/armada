import { expect, test } from "bun:test";
import { createGoldenBuildJob } from "../golden-worker.ts";
import { retentionMaintenanceJob } from "../retention-maintenance.ts";
import { startServerWorkers } from "../server-workers.ts";
import { createLaunchJob } from "./launch.ts";
import { createJobsRunner, type Job, type JobKind, type JobStore } from "./runner.ts";

function fixture(kind = "stop", dispatchBudgetMs?: number) {
  let now = 0;
  let claims = 0;
  let successfulRenewals = 0;
  let renewalUnavailable = false;
  const timers = new Map<() => void, number>();
  const rows = ["one", "two"].map((id) => ({
    id,
    kind,
    sandbox_id: kind === "maintenance" ? null : id,
    generation: kind === "maintenance" ? null : "1",
    lease_epoch: "0",
    attempts: 0,
    max_attempts: 2,
    payload: null,
    outcome: null,
    owner: "",
    expires: 0,
    terminal: false,
    due: 0,
  }));
  const current = (job: Job, owner: string) =>
    rows.find(
      (row) => row.id === job.id && row.owner === owner && row.lease_epoch === job.lease_epoch && row.expires > now,
    );
  const completed: string[] = [];
  const changed = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let renewalGate: Promise<void> | undefined;
  const store: JobStore = {
    async claimNext(kinds, limits, owner, seconds) {
      claims++;
      for (let i = 0; i < kinds.length; i++) {
        const currentKind = kinds[i]!;
        const concurrency = limits[i]!;
        const candidates = rows.filter((row) => row.kind === currentKind && !row.terminal);
        if (candidates.filter((row) => row.expires > now).length >= concurrency) continue;
        const row = candidates.find((row) => row.expires <= now && row.due <= now);
        if (!row) continue;
        row.owner = owner;
        row.expires = now + seconds * 1000;
        row.lease_epoch = String(++row.attempts);
        return { ...row, ...(dispatchBudgetMs === undefined ? {} : { dispatchBudgetMs }) };
      }
      return undefined;
    },
    async inspect(job, owner) {
      if (!current(job, owner)) return "lost";
      return job.attempts <= job.max_attempts ? "dispatch" : "reconcile";
    },
    async retireStale() {},
    async handoffGeneration() {
      throw new Error("Unexpected turn admission.");
    },
    async renew(job, owner, seconds) {
      if (renewalGate) await renewalGate;
      const row = current(job, owner);
      if (!row || renewalUnavailable) return false;
      row.expires = now + seconds * 1000;
      successfulRenewals++;
      return true;
    },
    async complete(job, owner, result) {
      completed.push(job.id);
      const row = current(job, owner);
      if (!row) return false;
      row.terminal = result.status !== "retry";
      if (result.status === "retry") row.due = result.after.getTime();
      row.expires = now;
      changed.get(row.id)?.resolve();
      return true;
    },
  };
  return {
    runner(run: JobKind["run"], concurrency = 1, options: Pick<JobKind, "drain" | "timeoutMs"> = {}) {
      return createJobsRunner(
        store,
        { [kind]: { run, concurrency, ...options } },
        () => {},
        (ms, callback) => {
          timers.set(callback, now + ms);
          return () => timers.delete(callback);
        },
      );
    },
    advance(ms: number) {
      now += ms;
      for (const [callback, due] of timers) {
        if (due > now) continue;
        timers.delete(callback);
        callback();
      }
    },
    loseRenewal() {
      renewalUnavailable = true;
    },
    settled(id: string) {
      const settled = Promise.withResolvers<void>();
      changed.set(id, settled);
      return settled.promise;
    },
    completed,
    get claims() {
      return claims;
    },
    get successfulRenewals() {
      return successfulRenewals;
    },
    holdRenewal(gate: Promise<void>) {
      renewalGate = gate;
    },
  };
}

const tick = new AbortController().signal;

test("a Boat launch stays fenced when the claiming worker cannot serve Boat", async () => {
  const f = fixture("launch");
  const handler = createLaunchJob({ modal: { concurrency: 1, run: async () => ({ status: "done" }) } });
  const runner = f.runner((job, context) => handler.run({ ...job, payload: { boat: {} } }, context));
  expect(await runner.reconcileOne(tick)).toBe(true);
  await runner.drain();
  expect(f.completed).toEqual([]);
  expect(await runner.reconcileOne(tick)).toBe(false);
});

test("the jobs lane admits two due initial turns while a sibling lane and the first turn are in flight", async () => {
  const f = fixture("launch_initial_turn");
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSibling = Promise.withResolvers<boolean>();
  const started: string[] = [];
  const runner = f.runner(async (job) => {
    started.push(job.id);
    if (job.id === "one") await releaseFirst.promise;
    return { status: "done" };
  }, 2);
  const workers = startServerWorkers([runner, { reconcileOne: () => releaseSibling.promise, async drain() {} }]);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["one", "two"]);
    expect(f.completed).not.toContain("one");
  } finally {
    workers.stop();
    releaseFirst.resolve();
    releaseSibling.resolve(false);
    await workers.done;
  }
});

test("an exhausted stop job still reaches its handler for recovery", async () => {
  const f = fixture();
  const attempts: number[] = [];
  const runner = f.runner(async (job) => {
    attempts.push(job.attempts);
    return job.attempts <= job.max_attempts ? { status: "retry", after: new Date(0) } : { status: "done" };
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await runner.reconcileOne(tick)).toBe(true);
    await runner.drain();
  }
  expect(attempts).toEqual([1, 2, 3]);
});

test("a renewed Boat extension attempt aborts at its original dispatch deadline", async () => {
  const f = fixture("boat_runtime_extend", 12_000);
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const runner = f.runner(async (_job, { signal }) => {
    entered.resolve(signal);
    await finish.promise;
    return { status: "done" };
  });
  expect(await runner.reconcileOne(tick)).toBe(true);
  const signal = await entered.promise;
  try {
    f.advance(10_000);
    await Promise.resolve();
    expect(f.successfulRenewals).toBe(1);
    expect(signal.aborted).toBe(false);
    f.advance(2_000);
    expect(signal.aborted).toBe(true);
  } finally {
    finish.resolve();
    await runner.drain();
  }
  expect(f.completed).toEqual([]);
});

test.each([0, -1])("a Boat extension claim with dispatch budget %i skips the handler", async (budget) => {
  const f = fixture("boat_runtime_extend", budget);
  let entered = false;
  const runner = f.runner(async () => {
    entered = true;
    return { status: "done" };
  });
  expect(await runner.reconcileOne(tick)).toBe(true);
  await runner.drain();
  expect(entered).toBe(false);
  expect(f.completed).toEqual([]);
});

test("lease loss aborts the active handler, allows takeover, and ignores the late result", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const runner = f.runner(async (job, { signal }) => {
    if (job.attempts > 1) return { status: "done" };
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    return { status: "done" };
  });
  await runner.reconcileOne(tick);
  await started.promise;
  f.loseRenewal();
  f.advance(10_000);
  await aborted.promise;
  f.advance(20_000);
  expect(await runner.reconcileOne(tick)).toBe(true);
  finish.resolve();
  await runner.drain();
  expect(f.completed).toEqual(["one"]);
});

test("shutdown drains a renewal that is still in flight", async () => {
  const f = fixture();
  const renewal = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  f.holdRenewal(renewal.promise);
  const runner = f.runner(async (_job, { signal }) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "done" };
  });
  await runner.reconcileOne(tick);
  await started.promise;
  f.advance(10_000);
  runner.stopAdmission();
  const drained = runner.drain();
  try {
    const nextTurn = new Promise<string>((resolve) => setImmediate(() => resolve("pending")));
    expect(await Promise.race([drained.then(() => "drained"), nextTurn])).toBe("pending");
  } finally {
    renewal.resolve();
    await drained;
  }
});

test("a second runner respects the registered kind's capacity until the lease is released", async () => {
  const f = fixture();
  const finish = Promise.withResolvers<void>();
  const first = f.runner(async () => {
    await finish.promise;
    return { status: "done" };
  });
  const second = f.runner(async () => ({ status: "done" }));
  expect(await first.reconcileOne(tick)).toBe(true);
  expect(await second.reconcileOne(tick)).toBe(false);
  finish.resolve();
  await first.drain();
  expect(await second.reconcileOne(tick)).toBe(true);
  await second.drain();
  expect(f.completed).toEqual(["one", "two"]);
});

test.each([false, true])("dispatch timeout fences late completion only on ownership loss (%s)", async (takeover) => {
  const f = fixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const first = f.runner(
    async (_job, { signal }) => {
      entered.resolve(signal);
      await finish.promise;
      return { status: "done" };
    },
    1,
    { timeoutMs: 15_000 },
  );
  expect(await first.reconcileOne(tick)).toBe(true);
  const signal = await entered.promise;
  f.advance(10_000);
  await Promise.resolve();
  expect(f.successfulRenewals).toBe(1);
  expect(signal.aborted).toBe(false);
  f.advance(5_000);
  expect(signal.aborted).toBe(true);
  if (takeover) {
    const second = f.runner(async () => ({ status: "done" }));
    f.advance(25_000);
    expect(await first.reconcileOne(tick)).toBe(false);
    expect(await second.reconcileOne(tick)).toBe(true);
    await second.drain();
    expect(f.completed).toEqual(["one"]);
  }
  finish.resolve();
  await first.drain();
  expect(f.completed).toEqual(["one"]);
});

test("shutdown drains an in-flight retention sweep without completing its lease", async () => {
  const f = fixture("maintenance");
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const handler = retentionMaintenanceJob(
    {
      async query() {
        return { rows: [] };
      },
    },
    {
      async purgeExpired() {
        entered.resolve();
        await released.promise;
      },
    },
    () => {},
    () => new Date(0),
  );
  const runner = f.runner(handler.run, handler.concurrency);
  expect(await runner.reconcileOne(tick)).toBe(true);
  await entered.promise;
  runner.stopAdmission();
  const drained = runner.drain();
  try {
    const nextTurn = new Promise<string>((resolve) => setImmediate(() => resolve("pending")));
    expect(await Promise.race([drained.then(() => "drained"), nextTurn])).toBe("pending");
  } finally {
    released.resolve();
    await drained;
  }
  expect(f.completed).toEqual([]);
});

test("hung golden recovery yields its lease to the next build and stays tracked through drain", async () => {
  const f = fixture("golden_build");
  const deadline = new AbortController();
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const released = Promise.withResolvers<void>();
  const handler = createGoldenBuildJob(
    {
      async dispatchReceipt(id, _epoch, _signal, recover) {
        if (id === "two") return { processed: true, pending: false };
        await recover?.(async (signal) => {
          entered.resolve(signal);
          await released.promise;
        });
        return { processed: false, pending: true };
      },
    },
    () => 0,
    () => deadline.signal,
  );
  const runner = f.runner(handler.run, handler.concurrency, { drain: handler.drain });
  const recoveryRetried = f.settled("one");
  const nextBuildDone = f.settled("two");
  try {
    expect(await runner.reconcileOne(tick)).toBe(true);
    const signal = await entered.promise;
    expect(await runner.reconcileOne(tick)).toBe(false);
    deadline.abort();
    await recoveryRetried;
    expect(signal?.aborted).toBe(true);
    expect(await runner.reconcileOne(tick)).toBe(true);
    await nextBuildDone;
    expect(await runner.reconcileOne(tick)).toBe(false);
    const drained = runner.drain();
    const nextTurn = new Promise<string>((resolve) => setImmediate(() => resolve("pending")));
    expect(await Promise.race([drained.then(() => "drained"), nextTurn])).toBe("pending");
  } finally {
    deadline.abort();
    released.resolve();
    await runner.drain();
  }
});

test("reconcileOne skips store.claimNext while a kind holds its local leased concurrency", async () => {
  const f = fixture();
  const finish = Promise.withResolvers<void>();
  const runner = f.runner(async () => {
    await finish.promise;
    return { status: "done" };
  });
  expect(await runner.reconcileOne(tick)).toBe(true);
  expect(await runner.reconcileOne(tick)).toBe(false);
  expect(f.claims).toBe(1);
  finish.resolve();
  await runner.drain();
});

test("reconcileOne batches all eligible kinds into one claimNext call, omits saturated/unprepared kinds, and rotates priority", async () => {
  const calls: Array<{ kinds: readonly string[]; limits: readonly number[] }> = [];
  const queue: Job[] = [];
  const finishBeta = Promise.withResolvers<void>();
  let gammaReady = false;
  const ran: string[] = [];

  const store: JobStore = {
    async claimNext(kinds, limits, owner) {
      calls.push({ kinds, limits });
      for (const kind of kinds) {
        const idx = queue.findIndex((job) => job.kind === kind);
        if (idx >= 0) {
          const [job] = queue.splice(idx, 1);
          return { ...job!, lease_owner: owner };
        }
      }
      return undefined;
    },
    async inspect() {
      return "dispatch";
    },
    async retireStale() {},
    async handoffGeneration() {
      throw new Error("Unexpected handoff.");
    },
    async renew() {
      return true;
    },
    async complete() {
      return true;
    },
  };

  const runner = createJobsRunner(
    store,
    {
      alpha: {
        concurrency: 2,
        run: async (job) => {
          ran.push(job.id);
          return { status: "done" };
        },
      },
      beta: {
        concurrency: 1,
        run: async (job) => {
          ran.push(job.id);
          await finishBeta.promise;
          return { status: "done" };
        },
      },
      gamma: {
        concurrency: 3,
        prepare: async () => gammaReady,
        run: async (job) => {
          ran.push(job.id);
          return { status: "done" };
        },
      },
    },
    () => {},
  );

  expect(await runner.reconcileOne(tick)).toBe(false);
  expect(calls).toEqual([{ kinds: ["alpha", "beta"], limits: [2, 1] }]);

  const makeJob = (id: string, kind: string) =>
    ({
      id,
      kind,
      sandbox_id: null,
      generation: null,
      lease_epoch: "1",
      attempts: 1,
      max_attempts: 1,
      payload: null,
      outcome: null,
    }) satisfies Job;
  queue.push(makeJob("b1", "beta"), makeJob("a1", "alpha"), makeJob("g1", "gamma"));
  gammaReady = true;

  expect(await runner.reconcileOne(tick)).toBe(true);
  expect(calls[1]).toEqual({ kinds: ["alpha", "beta", "gamma"], limits: [2, 1, 3] });

  expect(await runner.reconcileOne(tick)).toBe(true);
  expect(calls[2]).toEqual({ kinds: ["beta", "gamma", "alpha"], limits: [1, 3, 2] });

  expect(await runner.reconcileOne(tick)).toBe(true);
  expect(calls[3]).toEqual({ kinds: ["gamma", "alpha"], limits: [3, 2] });

  finishBeta.resolve();
  await runner.drain();
  expect(ran).toEqual(["a1", "b1", "g1"]);
});
