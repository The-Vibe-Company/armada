import { expect, test } from "bun:test";
import { createJobsRunner, type Job, type JobStore } from "./runner.ts";

function fixture() {
  let now = 0;
  let generation = "1";
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
  const retired: string[] = [];
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
      if (job.generation !== generation) return "stale";
      return job.attempts <= job.max_attempts ? "dispatch" : "reconcile";
    },
    async retireStale(job, owner) {
      const row = current(job, owner);
      if (row) {
        row.terminal = true;
        retired.push(row.id);
      }
    },
    async renew(job, owner, seconds) {
      const row = current(job, owner);
      if (!row || job.generation !== generation) return false;
      row.expires = now + seconds * 1000;
      return true;
    },
    async complete(job, owner) {
      if (loseCompletion) throw new Error("Database disconnected before commit.");
      completed.push(job.id);
      const row = current(job, owner);
      if (row && job.generation === generation) row.terminal = true;
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
    changeGeneration() {
      generation = "2";
    },
    loseCompletion(value: boolean) {
      loseCompletion = value;
    },
    completed,
    retired,
  };
}

const tick = new AbortController().signal;

test("lease loss aborts an active handler and ignores its late result", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const runner = f.runner(async (_job, { signal }) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    return { status: "done" };
  });
  await runner.reconcileOne(tick);
  await started.promise;
  f.changeGeneration();
  f.advance(10_000);
  await aborted.promise;
  finish.resolve();
  await runner.drain();
  expect(f.completed).toEqual([]);
});

test("a claimed stale generation is retired without invoking its handler", async () => {
  const f = fixture();
  f.changeGeneration();
  const runner = f.runner(async () => {
    throw new Error("A stale handler must never run.");
  });
  expect(await runner.reconcileOne(tick)).toBe(true);
  await runner.drain();
  expect(f.retired).toEqual(["one"]);
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
