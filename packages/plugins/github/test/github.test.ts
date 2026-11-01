import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fold } from "@armada/daemon/fold";
import { EventStore } from "@armada/daemon/store";
import type { GithubCheckpoint } from "../src/checkpoint.ts";
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

test("active PR review comments and root/reply threads survive replay, 304 and resolution", async () => {
  const store = new EventStore(":memory:");
  let at = "2030-01-01T12:00:00Z";
  let resolved = false;
  let behind = 0;
  let conditional = false;
  const requests: string[] = [];
  const comment = (id: number, reply?: number) => ({
    id,
    node_id: `comment-${id}`,
    in_reply_to_id: reply,
    user: { login: id === 1 ? "owner" : "reviewer" },
    body: id === 1 ? "Please fix this" : "Agreed",
    path: "boat.ts",
    line: 12,
    html_url: `https://github.com/acme/boats/pull/41#discussion_r${id}`,
    created_at: "2030-01-01T11:59:58Z",
    updated_at: "2030-01-01T11:59:58Z",
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/issues/")) return Response.json([]);
    if (url.includes("/compare/")) return Response.json({ behind_by: behind });
    if (url.includes("/comments?")) {
      conditional = new Headers(init?.headers).get("if-none-match") === '"comments-v1"';
      return conditional
        ? new Response(null, { status: 304 })
        : Response.json([comment(1), comment(2, 1)], { headers: { etag: '"comments-v1"' } });
    }
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("ReviewThreads"))
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    isResolved: resolved,
                    path: "boat.ts",
                    line: 12,
                    comments: {
                      nodes: [
                        {
                          databaseId: 1,
                          author: { login: "owner" },
                          body: "Please fix this",
                          url: comment(1).html_url,
                          createdAt: comment(1).created_at,
                        },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    return Response.json(
      page([
        pull(41, { author: { login: "worker" }, baseRefOid: "base", mergeStateStatus: "DIRTY" }),
        pull(42, { headRefName: "unowned" }),
      ]),
    );
  };
  const options = {
    ...identity,
    store,
    fetch,
    token: async () => randomUUID(),
    activeTickets: () => new Set(["BOAT-7"]),
    now: () => new Date(at),
  };
  try {
    const reader = new GithubReader(options);
    assert.equal((await reader.refresh()).ok, true);
    const events = store.readSince(0);
    assert.equal(events.filter((e) => e.kind === "pull-request.commented").length, 2);
    assert.equal(events.filter((e) => e.kind === "review-thread.opened").length, 1);
    assert.equal(events.filter((e) => e.kind === "pull-request.conflicting").length, 1);
    assert.equal(fold(events).projects.boats?.pullRequests.find((pr) => pr.number === 41)?.unresolvedThreads, 1);
    const count = events.filter((e) => e.kind !== "coordinator.checkpoint").length;
    at = "2030-01-01T12:00:30Z";
    await new GithubReader(options).refresh();
    assert.equal(conditional, true);
    assert.ok(requests.some((url) => url.includes("since=2030-01-01T11%3A59%3A55.000Z")));
    assert.equal(store.readSince(0).filter((e) => e.kind !== "coordinator.checkpoint").length, count);
    assert.equal(
      requests.some((url) => url.includes("/42/comments")),
      false,
    );
    resolved = true;
    behind = 2;
    await reader.refresh();
    assert.equal(store.readSince(0).filter((e) => e.kind === "review-thread.resolved").length, 1);
    assert.equal(store.readSince(0).filter((e) => e.kind === "pull-request.behind").length, 1);
    await reader.refresh();
    assert.equal(store.readSince(0).filter((e) => e.kind === "pull-request.behind").length, 1);
    assert.equal(
      fold(store.readSince(0)).projects.boats?.pullRequests.find((pr) => pr.number === 41)?.unresolvedThreads,
      0,
    );
  } finally {
    store.close();
  }
});

test("a PR's 404 retains its cursor and failure count across restart; 24h abandons it, 410 drops immediately", async () => {
  for (const status of [404, 410]) {
    const store = new EventStore(":memory:");
    let at = "2030-01-01T12:00:00Z";
    let failure = false;
    let calls = 0;
    const options = {
      ...identity,
      store,
      activeTickets: () => new Set(["BOAT-7"]),
      now: () => new Date(at),
      token: async () => randomUUID(),
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/issues/")) return Response.json([]);
        if (String(input).includes("/comments?")) {
          calls++;
          return failure ? new Response(null, { status }) : Response.json([]);
        }
        const { query } = JSON.parse(String(init?.body));
        if (query.includes("ReviewThreads"))
          return Response.json({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
          });
        return Response.json(page([pull()]));
      },
    };
    try {
      await new GithubReader(options).refresh();
      failure = true;
      at = "2030-01-01T12:01:00Z";
      await new GithubReader(options).refresh();
      const checkpoint = () =>
        store.readSince(0).findLast((e) => e.kind === "coordinator.checkpoint")?.payload.checkpoint as GithubCheckpoint;
      assert.equal(checkpoint().prs["41"]?.cursor, "2030-01-01T12:00:00.000Z");
      assert.equal(checkpoint().prs["41"]?.failures, 1);
      at = "2030-01-02T12:01:00Z";
      await new GithubReader(options).refresh();
      assert.ok(checkpoint().prs["41"]?.abandoned);
      const before = calls;
      await new GithubReader(options).refresh();
      assert.equal(calls, before);
    } finally {
      store.close();
    }
  }
});

test("429 persists doubling backoff and honors server cooldowns without another request", async () => {
  const store = new EventStore(":memory:");
  let at = "2030-01-01T12:00:00Z";
  let calls = 0;
  const options = {
    ...identity,
    store,
    now: () => new Date(at),
    token: async () => randomUUID(),
    fetch: async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "x-poll-interval": "45", "retry-after": "50" } });
    },
  };
  try {
    const reader = new GithubReader(options);
    await reader.refresh();
    assert.equal(reader.state().backoffMs, 60_000);
    await new GithubReader(options).refresh();
    assert.equal(calls, 1);
    at = "2030-01-01T12:01:00Z";
    const restarted = new GithubReader(options);
    await restarted.refresh();
    assert.equal(restarted.state().backoffMs, 120_000);
  } finally {
    store.close();
  }
});

test("a successful disappeared-PR lookup clears prior failure state for closed, merged and inactive PRs", async () => {
  for (const state of ["CLOSED", "MERGED", "OPEN"]) {
    const store = new EventStore(":memory:");
    let poll = 0;
    const reader = new GithubReader({
      ...identity,
      store,
      token: async () => randomUUID(),
      fetch: async (_url, init) => {
        const { query } = JSON.parse(String(init?.body));
        if (query.includes("query Pulls")) return Response.json(page(++poll === 1 ? [pull()] : []));
        return poll === 2
          ? new Response(null, { status: 404 })
          : Response.json({ data: { repository: { pullRequest: pull(41, { state }) } } });
      },
    });
    try {
      await reader.refresh();
      await reader.refresh();
      assert.deepEqual(
        reader.state().failures.map((p) => p.pr),
        [41],
      );
      await reader.refresh();
      assert.deepEqual(reader.state().failures, []);
      const restarted = new GithubReader({
        ...identity,
        store,
        token: async () => randomUUID(),
        fetch: recorded([page(state === "OPEN" ? [pull()] : [])]),
      });
      await restarted.refresh();
      assert.deepEqual(restarted.state().failures, []);
    } finally {
      reader.stop();
      store.close();
    }
  }
});

test("one PR failure and interrupted review appends preserve other PRs and replay each source once", async () => {
  for (const failKind of ["pull-request.commented", "review-thread.opened", "coordinator.checkpoint"]) {
    const store = new EventStore(":memory:");
    let interrupt = true;
    const body = "x".repeat(800);
    const comment = {
      id: 1,
      user: { login: "owner" },
      body,
      path: "boat.ts",
      line: 4,
      html_url: "https://github.com/acme/boats/pull/41#discussion_r1",
      created_at: "2030-01-01T12:00:00Z",
      updated_at: "2030-01-01T12:00:00Z",
    };
    const options = {
      ...identity,
      activeTickets: () => new Set(["BOAT-7"]),
      token: async () => randomUUID(),
      store: {
        readSince: (seq: number, project?: string) => store.readSince(seq, project),
        append: (event: Parameters<EventStore["append"]>[0]) => {
          if (interrupt && event.kind === failKind) {
            interrupt = false;
            throw new Error("Interrupted append");
          }
          return store.append(event);
        },
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/42/comments?")) return new Response(null, { status: 404 });
        if (url.includes("/issues/")) return Response.json([]);
        if (url.includes("/41/comments?")) return Response.json([comment]);
        const { query } = JSON.parse(String(init?.body));
        if (query.includes("ReviewThreads"))
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-1",
                        isResolved: false,
                        path: "boat.ts",
                        line: 4,
                        comments: {
                          nodes: [
                            {
                              databaseId: 1,
                              author: { login: "owner" },
                              body,
                              url: comment.html_url,
                              createdAt: comment.created_at,
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          });
        return Response.json(page([pull(41), pull(42)]));
      },
    };
    try {
      assert.equal((await new GithubReader(options).refresh()).ok, false);
      assert.equal((await new GithubReader(options).refresh()).ok, true);
      await new GithubReader(options).refresh();
      const comments = store.readSince(0).filter((e) => e.kind === "pull-request.commented");
      assert.equal(comments.length, 1);
      assert.equal(comments[0]?.payload.body.length, 600);
      assert.equal(store.readSince(0).filter((e) => e.kind === "review-thread.opened").length, 1);
      const checkpoint = store.readSince(0).findLast((e) => e.kind === "coordinator.checkpoint")?.payload
        .checkpoint as GithubCheckpoint;
      assert.equal(checkpoint.prs["41"]?.cursor, "2030-01-01T12:00:00.000Z");
      assert.ok((checkpoint.prs["42"]?.failures ?? 0) > 0);
      assert.equal(checkpoint.prs["42"]?.cursor, undefined);
    } finally {
      store.close();
    }
  }
});

test("a hung PR has its own deadline, preserves healthy peers and reaches abandonment without accumulating requests", async () => {
  const store = new EventStore(":memory:");
  const timer = clock();
  let at = "2030-01-01T12:00:00Z";
  let hangingCalls = 0;
  let entered: () => void = () => {};
  let release: (response: Response) => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hang = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const reader = new GithubReader({
    ...identity,
    store,
    schedule: timer.schedule,
    now: () => new Date(at),
    activeTickets: () => new Set(["BOAT-7"]),
    token: async () => randomUUID(),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pulls/41/comments?")) {
        hangingCalls++;
        entered();
        return hang;
      }
      if (url.includes("/issues/")) return Response.json([]);
      if (url.includes("/pulls/42/comments?"))
        return Response.json([
          {
            id: 2,
            user: { login: "owner" },
            body: "Healthy PR comment",
            html_url: "https://github.com/acme/boats/pull/42#discussion_r2",
            created_at: at,
            updated_at: at,
          },
        ]);
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("ReviewThreads"))
        return Response.json({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
        });
      return Response.json(page([pull(41), pull(42)]));
    },
  });
  try {
    const pending = reader.refresh();
    await waiting;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(timer.tasks.size, 1, "only the hung PR's deadline remains");
    timer.fire();
    assert.equal((await pending).ok, true);
    assert.equal(
      store.readSince(0).filter((e) => e.kind === "pull-request.commented" && e.payload.pr === 42).length,
      1,
    );
    assert.deepEqual(
      reader.state().failures.map((p) => [p.pr, p.failures]),
      [[41, 1]],
    );
    await reader.refresh();
    assert.equal(hangingCalls, 1, "an uncooperative request stays single-flight for its PR");
    at = "2030-01-02T12:00:00Z";
    await reader.refresh();
    assert.deepEqual(reader.state().abandoned, [41]);
    assert.equal(reader.state().failures.length, 0);
    const before = store.sequence;
    release(Response.json([]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.sequence, before, "late results append nothing");
  } finally {
    reader.stop();
    store.close();
  }
});

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
    const red = store.readSince(0).find((e) => e.kind === "pull-request.checks-red");
    assert.ok(red?.kind === "pull-request.checks-red");
    assert.deepEqual(red.payload.failingChecks, ["verify"]);
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
