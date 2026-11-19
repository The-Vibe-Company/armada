import { expect, test } from "bun:test";
import { createJobsRunner, type Job, type JobStore } from "./runner.ts";

function fixture() {
  let now = 0;
  let renewalUnavailable = false;
  const timers = new Map<() => void, number>();
  const rows = ["one", "two"].map((id) => ({
    id,
    kind: "stop",
    sandbox_id: id,
    generation: "1",
    lease_epoch: "0",
    attempts: 0,
    max_attempts: 2,
    payload: null,
    outcome: null,
    owner: "",
    expires: 0,
    terminal: false,
  }));
  const current = (job: Job, owner: string) =>
    rows.find(
      (row) => row.id === job.id && row.owner === owner && row.lease_epoch === job.lease_epoch && row.expires > now,
    );
  const completed: string[] = [];
  let renewalGate: Promise<void> | undefined;
  let loseCompletion = false;
  const store: JobStore = {
    async claim(kind, owner, seconds, concurrency) {
      const candidates = rows.filter((row) => row.kind === kind && !row.terminal);
      if (candidates.filter((row) => row.expires > now).length >= concurrency) return;
      const row = candidates.find((row) => row.expires <= now);
      if (!row) return;
      row.owner = owner;
      row.expires = now + seconds * 1000;
      row.lease_epoch = String(++row.attempts);
      return { ...row };
    },
    async inspect(job, owner) {
      if (!current(job, owner)) return "lost";
      return job.attempts <= job.max_attempts ? "dispatch" : "reconcile";
    },
    async retireStale() {},
    async renew(job, owner, seconds) {
      if (renewalGate) await renewalGate;
      const row = current(job, owner);
      if (!row || renewalUnavailable) return false;
      row.expires = now + seconds * 1000;
      return true;
    },
    async complete(job, owner) {
      if (loseCompletion) throw new Error("Database disconnected before commit.");
      completed.push(job.id);
      const row = current(job, owner);
      if (row) row.terminal = true;
    },
  };
  return {
    runner(run: Parameters<typeof createJobsRunner>[1][string]["run"], concurrency = 1) {
      return createJobsRunner(
        store,
        { stop: { run, concurrency } },
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
    loseCompletion(value: boolean) {
      loseCompletion = value;
    },
    completed,
    holdRenewal(gate: Promise<void>) {
      renewalGate = gate;
    },
  };
}

const tick = new AbortController().signal;

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

test("a crash before completion replays the same identity under a new epoch", async () => {
  const f = fixture();
  f.loseCompletion(true);
  const effects = new Set<string>();
  const epochs: string[] = [];
  const run = async (job: Job) => {
    effects.add(job.id);
    epochs.push(job.lease_epoch);
    return { status: "done" } as const;
  };
  const first = f.runner(run);
  await first.reconcileOne(tick);
  await first.drain();
  f.loseCompletion(false);
  f.advance(30_000);
  const successor = f.runner(run);
  await successor.reconcileOne(tick);
  await successor.drain();
  expect(epochs).toEqual(["1", "2"]);
  expect([...effects]).toEqual(["one"]);
  expect(f.completed).toEqual(["one"]);
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
