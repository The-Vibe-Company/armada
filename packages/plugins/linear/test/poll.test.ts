import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fold } from "@armada/daemon/fold";
import { EventStore } from "@armada/daemon/store";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { activate } from "../src/index.ts";
import { linearTracker } from "../src/linear/index.ts";
import { TrackerPoller } from "../src/poll.ts";

const start = Date.parse("2030-01-01T10:00:00Z");
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const root = {
  id: "root-uuid",
  identifier: "GROW-1",
  title: "Grow a garden",
  updatedAt: new Date(start).toISOString(),
  url: "https://linear.example/GROW-1",
  state: { type: "backlog" },
  assignee: null,
  parent: null,
  labels: page([]),
  attachments: page([]),
  inverseRelations: page([]),
};
function clock() {
  let time = start;
  const timers = new Map<() => void, number>();
  return {
    now: () => new Date(time),
    set(callback: () => void, delay: number) {
      timers.set(callback, time + delay);
      return () => {
        timers.delete(callback);
      };
    },
    async advance(ms: number) {
      time += ms;
      for (const [callback, due] of [...timers])
        if (due <= time) {
          timers.delete(callback);
          callback();
        }
      await setImmediate();
    },
    timers,
  };
}
function setup(
  response?: (operation: string, call: number) => Response,
  c = clock(),
  store = new EventStore(":memory:"),
) {
  const calls: string[] = [];
  const tracker = linearTracker({
    project: "garden",
    rootId: "GROW-1",
    phaseGroup: "Agent phase",
    now: c.now,
    secrets: async () => "synthetic-key",
    fetch: async (_url, init) => {
      const operation = /query\s+(\w+)/.exec(JSON.parse(String(init.body)).query)?.[1] ?? "?";
      calls.push(operation);
      if (response) return response(operation, calls.length);
      return success(operation);
    },
  });
  const poller = new TrackerPoller({ project: "garden", tracker, store, clock: c });
  return { c, store, poller, calls, tracker };
}
function success(operation: string): Response {
  const data =
    operation === "Root"
      ? { issue: root }
      : operation === "Comments"
        ? { issues: { nodes: [{ identifier: root.identifier, comments: page([]) }] } }
        : { issues: page([]), comments: page([]) };
  return Response.json({ data });
}

test("Retry-After pauses every refresh path for 120 seconds, survives restart, then resumes once", async (t) => {
  const { poller, c, store, calls } = setup((op, n) =>
    n === 1 ? new Response("withheld", { status: 429, headers: { "Retry-After": "120" } }) : success(op),
  );
  t.after(() => {
    poller.stop();
    store.close();
  });
  poller.start();
  await poller.readNow();
  assert.equal(calls.length, 1);
  assert.equal(poller.status.pausedUntil, "2030-01-01T10:02:00.000Z");
  for (let i = 0; i < 4; i++) await poller.readNow();
  await c.advance(119_999);
  assert.equal(calls.length, 1, "manual refresh and scheduler cannot bypass the deadline");
  const restarted = setup(undefined, c, store);
  await restarted.poller.readNow();
  assert.equal(restarted.calls.length, 0, "restarting cannot bypass the deadline");
  restarted.poller.stop();
  await c.advance(1);
  await poller.readNow();
  assert.equal(calls.filter((op) => op === "Root").length, 2, "exactly one resumed read");
  assert.equal(poller.status.error, null);
});

test("a fresh persisted cursor resumes incrementally; six-hour expiry reconciles the root", async (t) => {
  const { poller, c, store } = setup();
  t.after(() => {
    poller.stop();
    store.close();
  });
  await poller.readNow();
  assert.equal(poller.status.error, null);
  poller.stop();
  await c.advance(60_000);
  const restart = setup(undefined, c, store);
  await restart.poller.readNow();
  assert.equal(restart.poller.status.error, null);
  assert.ok(restart.calls.includes("Changed"));
  assert.ok(!restart.calls.includes("Root"));
  restart.poller.stop();
  await c.advance(6 * 60 * 60_000);
  const expired = setup(undefined, c, store);
  await expired.poller.readNow();
  assert.equal(expired.poller.status.error, null);
  assert.ok(expired.calls.includes("Root"));
  expired.poller.stop();
});

test("usage counts each outgoing page and failure, records numeric headers and survives restart within the hour", async (t) => {
  const { poller, c, store, calls } = setup((op) => {
    const response = success(op);
    response.headers.set("X-Complexity", "12");
    response.headers.set("X-RateLimit-Requests-Remaining", "1400");
    return response;
  });
  t.after(() => {
    poller.stop();
    store.close();
  });
  await poller.readNow();
  assert.equal(poller.status.usage?.requests, calls.length);
  assert.equal(poller.status.usage?.complexity, 12);
  assert.equal(fold(store.readSince(0)).projects.garden?.readers?.linear?.requests, calls.length);
  assert.equal(poller.status.usage?.rateLimit?.["x-ratelimit-requests-remaining"], 1400);
  const restart = setup(() => new Response("withheld", { status: 500 }), c, store);
  await restart.poller.readNow();
  assert.equal(restart.poller.status.usage?.requests, calls.length + 1);
  await c.advance(60 * 60_000);
  await restart.poller.readNow();
  assert.equal(restart.poller.status.usage?.requests, 1);
  restart.poller.stop();
});

test("rate-limit evidence handles dates, caps, reset headers and GraphQL errors without retrying", async (t) => {
  const cases = [
    { status: 200, headers: { "Retry-After": "120" }, seconds: 120 },
    { status: 429, headers: { "Retry-After": "Tue, 01 Jan 2030 10:02:00 GMT" }, seconds: 120 },
    { status: 429, headers: { "Retry-After": "7200" }, seconds: 3600 },
    { status: 429, headers: { "Retry-After": "invalid" }, seconds: 3600 },
    { status: 429, headers: {}, seconds: 3600 },
    { status: 400, headers: { "X-RateLimit-Complexity-Reset": String(start + 120_000) }, seconds: 120 },
  ];
  for (const [i, entry] of cases.entries())
    await t.test(String(i), async () => {
      const { poller, c, store, calls } = setup(() =>
        Response.json(
          { errors: [{ extensions: { code: "RATELIMITED" } }] },
          {
            status: entry.status,
            headers: new Headers(Object.entries(entry.headers).map(([key, value]) => [key, String(value)])),
          },
        ),
      );
      try {
        await poller.readNow();
        assert.equal(poller.status.pausedUntil, new Date(start + entry.seconds * 1000).toISOString());
        await c.advance(entry.seconds * 1000 - 1);
        await poller.readNow();
        assert.equal(calls.length, 1);
        assert.equal(poller.status.usage?.requests, 1);
      } finally {
        poller.stop();
        store.close();
      }
    });
});

test("projects sharing a budget pause refreshes as soon as one is limited", async (t) => {
  const first = setup(() => new Response("withheld", { status: 429, headers: { "Retry-After": "120" } }));
  const c = first.c;
  let otherRequests = 0;
  const other = new TrackerPoller({
    project: "other",
    store: first.store,
    clock: c,
    tracker: linearTracker({
      project: "other",
      rootId: "GROW-1",
      phaseGroup: "Agent phase",
      now: c.now,
      budget: first.tracker.budget,
      secrets: async () => "synthetic-key",
      fetch: async () => {
        otherRequests++;
        return success("Root");
      },
    }),
  });
  t.after(() => {
    first.poller.stop();
    other.stop();
    first.store.close();
  });
  await first.poller.readNow();
  await other.readNow();
  assert.equal(otherRequests, 0);
  assert.equal(other.status.pausedUntil, "2030-01-01T10:02:00.000Z");
});

test("provider restart restores pauses only for the same credential, including a different project sharing it", async (t) => {
  const store = new EventStore(":memory:");
  t.after(() => store.close());
  const keys: Record<string, string> = {
    garden: "synthetic-key-one",
    orchard: "synthetic-key-two",
    shared: "synthetic-key-one",
  };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("Authorization");
    const operation = /query\s+(\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1] ?? "?";
    calls.push(key === "synthetic-key-one" ? "limited" : "other");
    if (key === "synthetic-key-one")
      return new Response("withheld", { status: 429, headers: { "Retry-After": "120" } });
    return success(operation);
  });
  const boot = () => {
    let provider: TrackerProvider | undefined;
    activate({
      config: {
        tracker: {
          linear: { projects: Object.fromEntries(Object.keys(keys).map((p) => [p, { programRoot: "GROW-1" }])) },
        },
      },
      register: {
        tracker: (_kind: string, value: TrackerProvider) => {
          provider = value;
        },
      } as PluginContext["register"],
      events: {
        read: async (p, seq) => store.readSince(seq, p),
        append: async (e) => store.append(e as Parameters<EventStore["append"]>[0]),
        fold: async () => null,
      },
      secrets: { get: async (_name, p) => keys[p ?? ""] ?? null },
      log: { info() {}, error() {} },
    });
    assert.ok(provider);
    return provider;
  };
  const first = boot();
  const limited = await first.read({ project: "garden" });
  assert.ok(limited?.pausedUntil);
  await first.read({ project: "orchard" });
  assert.equal(calls.filter((c) => c === "other").length, 3, "a distinct key completes a full read");
  const before = calls.length;
  const restart = boot();
  const shared = await restart.read({ project: "shared" });
  assert.equal(
    shared?.pausedUntil,
    limited.pausedUntil,
    "another project restores the shared key pause before polling",
  );
  assert.equal(calls.length, before);
  await restart.read({ project: "orchard" });
  assert.equal(calls.length, before + 1, "the unrelated key resumes its cursor in one delta request");
  keys.garden = "synthetic-key-three";
  await boot().read({ project: "garden" });
  assert.equal(calls.length, before + 4, "a changed credential never inherits the old credential's pause");
});

test("the poller deadline covers preparation, releases callers and fences late prepared reads", async () => {
  const c = clock();
  const store = new EventStore(":memory:");
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparations = 0;
  let requests = 0;
  const poller = new TrackerPoller({
    project: "garden",
    store,
    clock: c,
    tracker: {
      prepare: async () => {
        if (++preparations === 1) await waiting;
      },
      read: async () => {
        requests++;
        return { startedAt: c.now().toISOString(), tickets: [], comments: [] };
      },
    },
  });
  let finished = false;
  const first = poller.readNow().then(() => {
    finished = true;
  });
  try {
    await setImmediate();
    assert.equal(preparations, 1);
    await c.advance(30_000);
    assert.equal(finished, true, "preparation cannot hold a caller past its deadline");
    assert.equal(poller.status.error, "Tracker read timed out");
    await poller.readNow();
    assert.equal(preparations, 1, "unsettled preparation stays single-flight");
    release();
    await setImmediate();
    assert.equal(requests, 0, "late preparation must not start an aborted request");
    await poller.readNow();
    assert.equal(requests, 1, "a later healthy preparation recovers");
  } finally {
    release();
    await first;
    poller.stop();
    store.close();
  }
});

test("provider boot restoration releases cancelled callers without piling up credential/history reads", async (t) => {
  for (const blockedAt of ["credential", "history"])
    await t.test(blockedAt, async (sub) => {
      const store = new EventStore(":memory:");
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let calls = 0;
      let failed = false;
      let requests = 0;
      sub.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        requests++;
        return success(/query\s+(\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1] ?? "?");
      });
      let provider: TrackerProvider | undefined;
      activate({
        config: { tracker: { linear: { projects: { garden: { programRoot: "GROW-1" } } } } },
        register: {
          tracker: (_kind: string, value: TrackerProvider) => {
            provider = value;
          },
        } as PluginContext["register"],
        secrets: {
          get: async () => {
            if (blockedAt === "credential") {
              calls++;
              entered();
              await waiting;
            }
            return "synthetic-key";
          },
        },
        events: {
          read: async (p, seq) => {
            if (blockedAt === "history") {
              calls++;
              entered();
              await waiting;
              if (!failed) {
                failed = true;
                throw new Error("Synthetic history outage");
              }
            }
            return store.readSince(seq, p);
          },
          append: async (e) => store.append(e as Parameters<EventStore["append"]>[0]),
          fold: async () => null,
        },
        log: { info() {}, error() {} },
      });
      assert.ok(provider);
      const controller = new AbortController();
      let finished = false;
      const first = provider.read({ project: "garden", signal: controller.signal }).then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      try {
        await started;
        controller.abort();
        await setImmediate();
        assert.equal(finished, true, "aborting a read must release its caller before restoration settles");
        const next = new AbortController();
        const second = provider.read({ project: "garden", signal: next.signal });
        next.abort();
        await assert.rejects(second);
        assert.equal(calls, 1, "retry joins the original restoration instead of accumulating work");
        release();
        await setImmediate();
        await provider.read({ project: "garden" });
        assert.equal(requests, 3, "a settled restoration outage can recover on the next read");
      } finally {
        release();
        await first;
        store.close();
      }
    });
});
