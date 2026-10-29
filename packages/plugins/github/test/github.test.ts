import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fold } from "@armada/daemon/fold";
import { EventStore } from "@armada/daemon/store";
import { GithubReader } from "../src/github.ts";

// Invented GraphQL recordings; credentials are generated at runtime, never recorded.
function pull(number = 41, changes: Record<string, unknown> = {}) {
  return {
    number,
    title: "Keep the boats afloat",
    url: `https://github.com/acme/boats/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "feature/boat-7-float",
    headRefOid: "aaa",
    reviewDecision: "REVIEW_REQUIRED",
    commits: {
      nodes: [
        {
          commit: {
            oid: "aaa",
            checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
            statusCheckRollup: {
              state: "PENDING",
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "verify", status: "IN_PROGRESS", conclusion: null, checkSuite: null },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    ...changes,
  };
}
function checks(head: string, conclusion: string, extra: Record<string, unknown> = {}) {
  return {
    nodes: [
      {
        commit: {
          oid: head,
          checkSuites: { nodes: [], pageInfo: { hasNextPage: false } },
          statusCheckRollup: {
            state: conclusion,
            contexts: {
              nodes: [
                { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
                { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion, checkSuite: null },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
          ...extra,
        },
      },
    ],
  };
}
function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { repository: { open: { nodes, pageInfo: { hasNextPage, endCursor } } } } };
}
function recorded(bodies: unknown[], requests: Record<string, unknown>[] = []) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)).variables);
    assert.ok(bodies.length, "unexpected GitHub request");
    return Response.json(bodies.shift());
  };
}
function clock() {
  const tasks = new Set<() => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      tasks.add(fn);
      return () => {
        tasks.delete(fn);
      };
    },
    fire: () => {
      for (const fn of [...tasks]) {
        tasks.delete(fn);
        fn();
      }
    },
    tasks,
  };
}
const identity = {
  project: "boats",
  repository: "acme/boats",
  actor: "owner",
  tickets: () => new Set(["BOAT-7"]),
  now: () => new Date("2030-01-01T12:00:00Z"),
};

test("two recorded readings persist only changed facts and transitions, with restart and project isolation", async () => {
  const store = new EventStore(":memory:");
  const credential = randomUUID();
  const first = pull();
  const green = pull(41, { headRefOid: "bbb", reviewDecision: "APPROVED", commits: checks("bbb", "SUCCESS") });
  const merged = pull(41, { ...green, state: "MERGED" });
  const requests: Record<string, unknown>[] = [];
  const fetch = recorded(
    [
      page([first]),
      page([green]),
      page([green]),
      page([]),
      { data: { repository: { pullRequest: merged } } },
      page([]),
    ],
    requests,
  );
  const options = { ...identity, store, fetch, token: async () => credential };
  try {
    const reader = new GithubReader(options);
    assert.equal((await reader.refresh()).ok, true);
    const cursor = store.readSince(0).at(-1)?.seq ?? 0;
    assert.deepEqual(
      store.readSince(0).map((e) => e.kind),
      ["pull-request.seen", "pull-request.opened"],
    );
    assert.equal((await reader.refresh()).ok, true);
    assert.deepEqual(
      store.readSince(cursor).map((e) => e.kind),
      ["pull-request.seen", "pull-request.head-moved", "pull-request.checks-green", "pull-request.review-changed"],
    );
    assert.equal(fold(store.readSince(0)).projects.boats?.pullRequests[0]?.ci, "success");
    const count = store.readSince(0).length;
    const restarted = new GithubReader(options);
    await restarted.refresh();
    assert.equal(store.readSince(0).length, count);
    await restarted.refresh();
    assert.deepEqual(
      store
        .readSince(0)
        .slice(count)
        .map((e) => e.kind),
      ["pull-request.seen", "pull-request.merged"],
    );
    assert.equal(requests.at(-1)?.number, 41);
    await new GithubReader(options).refresh();
    assert.equal(store.readSince(0).length, count + 2);
    assert.equal(fold(store.readSince(0)).projects.boats?.pullRequests[0]?.state, "merged");
    assert.equal(JSON.stringify(store.readSince(0)).includes(credential), false);
    await new GithubReader({ ...options, project: "another", fetch: recorded([page([first])]) }).refresh();
    assert.equal(store.readSince(0, "another").length, 2);
  } finally {
    store.close();
  }
});

test("pagination, red checks, closed PRs and malformed partial readings preserve complete observations", async () => {
  const store = new EventStore(":memory:");
  const credential = randomUUID();
  const requests: Record<string, unknown>[] = [];
  const first = pull(41, { commits: checks("aaa", "FAILURE") });
  const fetch = recorded(
    [
      page([first], true, "next"),
      page([pull(42)]),
      { ...page([]), errors: [{ message: credential }] },
      page([]),
      { data: { repository: { pullRequest: pull(41, { state: "CLOSED" }) } } },
      { data: { repository: { pullRequest: pull(42, { state: "CLOSED" }) } } },
    ],
    requests,
  );
  const reader = new GithubReader({ ...identity, store, fetch, token: async () => credential });
  try {
    await reader.refresh();
    assert.equal(requests[1]?.after, "next");
    assert.ok(store.readSince(0).some((e) => e.kind === "pull-request.checks-red"));
    const count = store.readSince(0).length;
    const failed = await reader.refresh();
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes(credential), false);
    assert.equal(store.readSince(0).length, count);
    await reader.refresh();
    assert.equal(store.readSince(0).filter((e) => e.kind === "pull-request.closed").length, 2);
  } finally {
    store.close();
  }
});

test("deadlines cover token, fetch and body hangs without late events; concurrent refreshes coalesce", async () => {
  for (const stage of ["token", "fetch", "body"] as const) {
    const store = new EventStore(":memory:");
    const timer = clock();
    let release: (value: never) => void = () => {};
    const hang = new Promise<never>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reader = new GithubReader({
      ...identity,
      store,
      schedule: timer.schedule,
      token: async () => {
        if (stage === "token") {
          entered();
          return hang;
        }
        return randomUUID();
      },
      fetch: async () => {
        if (stage === "fetch") {
          entered();
          return hang;
        }
        return Object.assign(new Response(), {
          json: () => {
            entered();
            return hang;
          },
        });
      },
    });
    try {
      const pending = reader.refresh();
      assert.equal(reader.refresh(), pending);
      await ready;
      timer.fire();
      assert.deepEqual(await pending, { ok: false, error: "GitHub reading timed out" });
      assert.deepEqual(await reader.refresh(), { ok: false, error: "GitHub reading still pending" });
      release(
        (stage === "token"
          ? randomUUID()
          : stage === "fetch"
            ? Response.json(page([pull()]))
            : page([pull()])) as never,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(store.readSince(0), []);
    } finally {
      store.close();
    }
  }
});

test("current workflow attempts replace stale failures, queued reruns cannot be green, truncated checks stay pending", async () => {
  const store = new EventStore(":memory:");
  const suite = (attempt: number, status: string, conclusion: string | null, head = "aaa") => ({
    status,
    conclusion,
    commit: { oid: head },
    workflowRun: { databaseId: 600 + attempt, runNumber: 20, runAttempt: attempt, workflow: { id: "verify" } },
  });
  const old = suite(1, "COMPLETED", "FAILURE");
  const fresh = suite(2, "COMPLETED", "SUCCESS");
  const queued = suite(3, "QUEUED", null);
  const commit = (suites: unknown[], contexts: unknown[], incomplete = false) => ({
    nodes: [
      {
        commit: {
          oid: "aaa",
          checkSuites: { nodes: suites, pageInfo: { hasNextPage: false } },
          statusCheckRollup: { state: "SUCCESS", contexts: { nodes: contexts, pageInfo: { hasNextPage: incomplete } } },
        },
      },
    ],
  });
  const contexts = [
    { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE", checkSuite: old },
    { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: fresh },
    {
      __typename: "CheckRun",
      name: "old head",
      status: "COMPLETED",
      conclusion: "FAILURE",
      checkSuite: suite(9, "COMPLETED", "FAILURE", "zzz"),
    },
  ];
  const reader = new GithubReader({
    ...identity,
    store,
    token: async () => randomUUID(),
    fetch: recorded([
      page([pull(41, { commits: commit([old, fresh], contexts) })]),
      page([pull(41, { commits: commit([old, fresh, queued], contexts) })]),
      page([pull(41, { commits: commit([fresh], contexts, true) })]),
    ]),
  });
  try {
    for (const expected of ["success", "pending", "pending"]) {
      assert.equal((await reader.refresh()).ok, true);
      assert.equal(fold(store.readSince(0)).projects.boats?.pullRequests[0]?.ci, expected);
    }
    assert.equal(store.readSince(0).filter((e) => e.kind === "pull-request.checks-green").length, 1);
  } finally {
    store.close();
  }
});

test("background polling returns immediately, stops on demand and never persists reflected credentials", async () => {
  const store = new EventStore(":memory:");
  const timer = clock();
  const credential = randomUUID();
  const reader = new GithubReader({
    ...identity,
    store,
    schedule: timer.schedule,
    token: async () => credential,
    fetch: recorded([page([pull(41, { title: credential, commits: checks("aaa", "SUCCESS") })])]),
  });
  try {
    const stop = reader.start();
    await reader.refresh();
    assert.equal(timer.tasks.size, 1, "only next poll remains after successful refresh");
    assert.equal(JSON.stringify(store.readSince(0)).includes(credential), false);
    assert.ok(JSON.stringify(store.readSince(0)).includes("[redacted]"));
    stop();
    assert.equal(timer.tasks.size, 0);
  } finally {
    reader.stop();
    store.close();
  }
});

test("interrupted appends recover missing transitions on restart without duplicate snapshots or facts", async () => {
  for (const failAt of [1, 2, 3]) {
    const store = new EventStore(":memory:");
    let appends = 0;
    const sink = {
      readSince: (seq: number, project?: string) => store.readSince(seq, project),
      append: (event: Parameters<EventStore["append"]>[0]) => {
        if (++appends === failAt) throw new Error("Interrupted store");
        return store.append(event);
      },
    };
    const green = pull(41, { commits: checks("aaa", "SUCCESS") });
    const options = {
      ...identity,
      store: sink,
      token: async () => randomUUID(),
      fetch: recorded([page([green]), page([green]), page([green])]),
    };
    try {
      assert.equal((await new GithubReader(options).refresh()).ok, false);
      assert.equal((await new GithubReader(options).refresh()).ok, true);
      assert.deepEqual(
        store.readSince(0).map((e) => e.kind),
        ["pull-request.seen", "pull-request.opened", "pull-request.checks-green"],
      );
      await new GithubReader(options).refresh();
      assert.equal(store.readSince(0).length, 3);
    } finally {
      store.close();
    }
  }
});
