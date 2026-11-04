import { expect, test } from "bun:test";
import { armadaApi } from "../src/armada-api.ts";
import { parseConfig } from "../src/config.ts";
import { fleetClient } from "../src/fleet-api.ts";
import type { MergePull } from "../src/github.ts";
import type { Fetch } from "../src/http.ts";
import { queueStalled } from "../src/live.ts";
import type { MergeContext } from "../src/merge.ts";
import { drainMergeQueue } from "../src/queue-drain.ts";
import { ARMADA_URL, DEMO_PROJECT, DEMO_TOML, FakeLinear, fakeArmada, fakeClock } from "./support.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const timeout = () =>
  new TypeError("fetch failed", { cause: Object.assign(new Error("connection"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

async function setup() {
  const clock = fakeClock();
  const service = fakeArmada({ clock, keys: { synthetic: "owner" } });
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  let transport: Fetch = service.fetch;
  const api = armadaApi({
    url: ARMADA_URL,
    random: () => 0.5,
    fetch: async (url, init) => {
      calls.push(url.split("/fleet/")[1] ?? "other");
      signals.push(init.signal!);
      return transport(url, init);
    },
  });
  const fleet = fleetClient({
    api,
    signIn: { kind: "api-key", key: "synthetic" },
    project: DEMO_PROJECT,
    // Exercise the real async coordinator lookup before transport.
    coordinatorName: async () => "default",
  });
  const pulls = new Map<number, MergePull>();
  for (const pr of [12, 15]) {
    pulls.set(pr, {
      number: pr,
      url: `https://github.com/acme/widgets/pull/${pr}`,
      repo: "acme/widgets",
      title: "fix: synthetic repair",
      state: "open",
      draft: false,
      ci: "success",
      checks: [{ name: "test", state: "success" }],
      mergeable: "MERGEABLE",
      headRef: "release",
      headSha: HEAD,
      baseRef: "main",
      mergeStateStatus: "CLEAN",
      mergeCommit: null,
      updatedAt: clock.now().toISOString(),
      mergedAt: null,
      reviewThreads: { total: 0, read: 0, unresolved: 0 },
    });
    await fleet.queueAdd({
      pr,
      ticket: null,
      noTicket: true,
      keepOpen: false,
      throughHold: null,
      reason: null,
      headSha: HEAD,
      queuedBy: "owner",
    });
  }
  const merged: number[] = [];
  const progress: string[] = [];
  let elapsed = 0;
  let sleeping: ((ms: number) => Promise<void>) | undefined;
  const ctx: MergeContext = {
    config: parseConfig(`${DEMO_TOML}\n[gates]\nrequired_checks = ["test"]\n`),
    linear: new FakeLinear(),
    repo: null,
    holder: "same-holder",
    lockRequired: true,
    now: clock.now,
    sleep: async (ms) => {
      elapsed += ms;
      clock.advance(ms);
      await sleeping?.(ms);
    },
    progress: (line) => progress.push(line),
    installedSkill: async () => false,
    fleet: async () => ({ fleet, warning: null }),
    afterRead: async () => ({ inFlight: [], unblocked: null }),
    forge: {
      readPull: async (pr) => structuredClone(pulls.get(pr) ?? null),
      compare: async () => ({ baseSha: BASE, status: "AHEAD", behindBy: 0, aheadBy: 1 }),
      diff: async () => "",
      commit: async () => null,
      updateBranch: async () => {
        throw new Error("unexpected branch update");
      },
      comment: async () => {},
      merge: async (pr) => {
        merged.push(pr);
        Object.assign(pulls.get(pr)!, { state: "merged", mergeCommit: COMMIT });
        return { ok: true, message: "merged", transient: false };
      },
    },
  };
  let pulse: (() => Promise<void>) | null = null;
  const drain = (signal?: AbortSignal) =>
    drainMergeQueue(ctx, fleet, {
      signal,
      monotonic: () => elapsed,
      every: (_ms, tick) => {
        pulse = tick;
        return () => {
          pulse = null;
        };
      },
      afterMerge: async () => {},
    });
  return {
    fleet,
    clock,
    service,
    calls,
    signals,
    ctx,
    merged,
    progress,
    pulls,
    drain,
    monotonic: () => elapsed,
    pulse: () => pulse?.(),
    transport: (fetch: Fetch) => {
      transport = fetch;
    },
    sleep: (fn: (ms: number) => Promise<void>) => {
      sleeping = fn;
    },
    advance: (ms: number) => {
      elapsed += ms;
      clock.advance(ms);
    },
  };
}

test("a transient renewal keeps the same entry while checks finish, with one recovery notice", async () => {
  const s = await setup();
  s.pulls.get(12)!.checks = [{ name: "test", state: "pending" }];
  let failed = 0;
  let recovering = false;
  s.transport(async (url, init) => {
    if (url.endsWith("lease/renew") && recovering && failed++ < 2) throw timeout();
    return s.service.fetch(url, init);
  });
  s.sleep(async () => {
    recovering = true;
    s.pulls.get(12)!.checks = [{ name: "test", state: "success" }];
  });
  await s.drain();
  expect(failed).toBeGreaterThanOrEqual(3);
  expect(s.merged).toEqual([12, 15]);
  expect(await s.fleet.queueList()).toMatchObject([
    { state: "merged", attempts: 0 },
    { state: "merged", attempts: 0 },
  ]);
  expect(s.progress.filter((line) => line.includes("Armada unreachable"))).toHaveLength(1);
  expect(queueStalled(await s.fleet.queueList(), null, s.clock.now())).toBeNull();
});

test.each(["before", "after"])(
  "queue selection recovers a response lost %s its transaction without changing FIFO or attempts",
  async (when) => {
    const s = await setup();
    let lost = false;
    s.transport(async (url, init) => {
      if (url.endsWith("queue/next") && !lost) {
        lost = true;
        if (when === "after") await s.service.fetch(url, init);
        throw timeout();
      }
      return s.service.fetch(url, init);
    });
    await s.drain();
    expect(lost).toBe(true);
    expect(s.merged).toEqual([12, 15]);
    expect(await s.fleet.queueList()).toMatchObject([
      { pr: 12, state: "merged", attempts: 0 },
      { pr: 15, state: "merged", attempts: 0 },
    ]);
  },
);

test("renewal exhaustion cannot extend the confirmed horizon and leaves the active row stalled", async () => {
  const s = await setup();
  s.pulls.get(12)!.checks = [{ name: "test", state: "pending" }];
  let outage = false;
  let failures = 0;
  s.sleep(async () => {
    outage = true;
  });
  s.transport(async (url, init) => {
    if (outage && url.endsWith("lease/renew")) {
      failures++;
      s.advance(10_000);
      throw timeout();
    }
    return s.service.fetch(url, init);
  });
  await expect(s.drain()).rejects.toThrow("unreachable");
  expect(failures).toBeGreaterThan(2);
  expect(s.monotonic()).toBeLessThanOrEqual(600_000);
  expect(s.merged).toEqual([]);
  const entries = await s.fleet.queueList();
  expect(entries).toMatchObject([
    { state: "merging", attempts: 0 },
    { state: "queued", attempts: 0 },
  ]);
  expect(queueStalled(entries, null, s.clock.now())).toMatchObject({
    kind: "queue-stalled",
    queueEntry: entries[0]!.id,
  });
  expect(s.progress.filter((line) => line.includes("Armada unreachable"))).toHaveLength(1);
});

test.each(["expired", "taken-over", "cancelled", "unauthorized", "forbidden"])(
  "lost selection closes safely when ownership is %s",
  async (scenario) => {
    const s = await setup();
    const cancellation = new AbortController();
    let selected = false;
    let selections = 0;
    let renewalsAfterLoss = 0;
    s.transport(async (url, init) => {
      if (url.endsWith("lease/renew") && selected) {
        renewalsAfterLoss++;
        if (scenario === "unauthorized" || scenario === "forbidden")
          return Response.json(
            { error: "CANARY_private_response_body" },
            { status: scenario === "unauthorized" ? 401 : 403 },
          );
      }
      if (url.endsWith("queue/next")) {
        selections++;
        if (!selected) {
          await s.service.fetch(url, init);
          selected = true;
          if (scenario === "expired") s.advance(600_001);
          if (scenario === "taken-over") {
            // Server time can move independently; fresh renewal must detect the other holder.
            s.clock.advance(600_001);
            expect(await s.fleet.acquireLease({ name: "merge-queue", holder: "peer", ttlMs: 600_000 })).toEqual({
              acquired: true,
            });
          }
          if (scenario === "cancelled") cancellation.abort(new DOMException("cancelled", "AbortError"));
          throw timeout();
        }
      }
      return s.service.fetch(url, init);
    });
    const failure = await s.drain(cancellation.signal).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(selected).toBe(true);
    expect(selections).toBe(1);
    if (["taken-over", "unauthorized", "forbidden"].includes(scenario)) expect(renewalsAfterLoss).toBe(1);
    expect(s.merged).toEqual([]);
    expect(await s.fleet.queueList()).toMatchObject([
      { state: "merging", attempts: 0 },
      { state: "queued", attempts: 0 },
    ]);
    expect(String(failure)).not.toContain("CANARY_private_response_body");
  },
);

test("a transient hold read cannot bypass an open pause, and progress recovers without counting an entry retry", async () => {
  const s = await setup();
  const hold = await s.fleet.openHold({ kind: "manual", reason: "synthetic deployment pause" });
  let holdFailed = false;
  let progressFailed = false;
  let sawPause = false;
  s.transport(async (url, init) => {
    if (url.endsWith("holds") && !holdFailed) {
      holdFailed = true;
      throw timeout();
    }
    if (url.endsWith("queue/progress") && !progressFailed) {
      progressFailed = true;
      return Response.json({}, { status: 503 });
    }
    return s.service.fetch(url, init);
  });
  s.sleep(async () => {
    if (s.progress.some((line) => line.includes("synthetic deployment pause"))) {
      sawPause = true;
      expect(s.merged).toEqual([]);
      await s.fleet.clearHold({ id: hold.id, reason: "fixed" });
    }
  });
  await s.drain();
  expect(holdFailed).toBe(true);
  expect(progressFailed).toBe(true);
  expect(sawPause).toBe(true);
  expect(s.merged).toEqual([12, 15]);
  expect(await s.fleet.queueList()).toMatchObject([
    { state: "merged", attempts: 0 },
    { state: "merged", attempts: 0 },
  ]);
});

test("pulse and foreground tick share one renewal episode, and a wall-clock jump cannot revive its budget", async () => {
  const s = await setup();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let renewalCalls = 0;
  s.transport(async (url, init) => {
    if (url.endsWith("lease/renew")) {
      renewalCalls++;
      if (renewalCalls === 1) {
        announce();
        await pending;
      }
    }
    return s.service.fetch(url, init);
  });
  const work = s.drain();
  await started;
  const pulse = s.pulse();
  await Promise.resolve();
  expect(renewalCalls).toBe(1);
  release();
  await pulse;
  await work;
  expect(s.merged).toEqual([12, 15]);

  // Separate negative: a backward wall-clock change cannot prolong unconfirmed ownership.
  const failing = await setup();
  let count = 0;
  failing.transport(async (url, init) => {
    if (url.endsWith("lease/renew")) {
      count++;
      failing.advance(100_000);
      failing.clock.advance(-200_000);
      throw timeout();
    }
    return failing.service.fetch(url, init);
  });
  await expect(failing.drain()).rejects.toThrow("unreachable");
  expect(count).toBeGreaterThan(1);
  expect(count).toBeLessThan(8);
  expect(failing.merged).toEqual([]);
});

test.each(["holds", "queue/progress"])(
  "permanent %s refusal stops the drain without retrying or merging",
  async (operation) => {
    const s = await setup();
    let failures = 0;
    s.transport(async (url, init) => {
      if (url.endsWith(`/${operation}`)) {
        failures++;
        return Response.json({ error: "CANARY_opaque_server_body" }, { status: 403 });
      }
      return s.service.fetch(url, init);
    });
    const failure = await s.drain().catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failures).toBe(1);
    expect(s.merged).toEqual([]);
    expect(String(failure)).not.toContain("CANARY_opaque_server_body");
  },
);

test("queue-list recovery preserves FIFO and a future retry time", async () => {
  const s = await setup();
  const holder = "previous";
  const until = new Date(s.clock.now().getTime() + 60_000).toISOString();
  await s.fleet.acquireLease({ name: "merge-queue", holder, ttlMs: 600_000 });
  const first = await s.fleet.queueNext({ holder });
  if (!("entry" in first) || !first.entry) throw new Error("missing selected entry");
  await s.fleet.queueFinish({
    id: first.entry.id,
    holder,
    outcome: "retry",
    detail: "checks pending",
    notBefore: until,
  });
  await s.fleet.releaseLease({ name: "merge-queue", holder });
  let lost = false;
  const merge = s.ctx.forge.merge;
  const times: number[] = [];
  s.ctx.forge.merge = async (...args) => {
    times.push(s.clock.now().getTime());
    return merge(...args);
  };
  s.transport(async (url, init) => {
    if (url.endsWith("queue/list") && !lost) {
      lost = true;
      throw timeout();
    }
    return s.service.fetch(url, init);
  });
  await s.drain();
  expect(lost).toBe(true);
  expect(s.merged).toEqual([12, 15]);
  expect(times[0]).toBeGreaterThanOrEqual(Date.parse(until));
  expect(await s.fleet.queueList()).toMatchObject([
    { pr: 12, state: "merged", attempts: 1 },
    { pr: 15, state: "merged", attempts: 0 },
  ]);
});

test.each(["lease/renew", "holds"])(
  "a malformed successful %s answer never grants authority or consumes queued intent",
  async (operation) => {
    const s = await setup();
    s.transport(async (url, init) => {
      if (url.endsWith(`/${operation}`)) return Response.json({ result: operation === "holds" ? null : {} });
      return s.service.fetch(url, init);
    });
    await expect(s.drain()).rejects.toThrow("invalid");
    expect(s.merged).toEqual([]);
    expect(s.calls.filter((op) => op === "queue/finish")).toEqual([]);
    expect(await s.fleet.queueList()).toMatchObject([
      { state: operation === "holds" ? "merging" : "queued", attempts: 0 },
      { state: "queued", attempts: 0 },
    ]);
  },
);
