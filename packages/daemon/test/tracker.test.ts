import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fold } from "../src/fold.ts";
import { EventStore } from "../src/store.ts";
import { type LinearFetch, linearTracker } from "../src/tracker/linear/index.ts";
import { TrackerPoller } from "../src/tracker/poll.ts";

const t0 = "2030-01-01T10:00:00.000Z";
const t1 = "2030-01-01T10:01:00.000Z";
const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const issue = (id: string, phase: string | null = null) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `Grow ${id}`,
  url: `https://linear.example/issue/${id}`,
  updatedAt: t0,
  state: { type: phase ? "started" : "backlog" },
  assignee: { name: "Mira" },
  parent: id === "SEED-1" ? null : { identifier: "SEED-1" },
  labels: page(phase ? [{ name: phase, parent: { name: "Fleet phase" } }] : []),
  attachments: page([]),
});
const comment = (id: string, body: string, at = t0) => ({
  id,
  body,
  createdAt: at,
  updatedAt: at,
  user: { name: "Mira" },
});
/** Synthetic recorded GraphQL responses, queued by operation (V1 support.ts pattern). */
function recorded(responses: Record<string, unknown[]>) {
  const calls: { operation: string; variables: Record<string, unknown> }[] = [];
  const fetch: LinearFetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /query\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ operation, variables });
    const data = responses[operation]?.shift();
    assert.ok(data, `unexpected ${operation}`);
    return Response.json({ data });
  };
  return { calls, fetch };
}
function initial(comments: unknown[] = []) {
  return {
    Root: [{ issue: issue("SEED-1") }],
    Children: [{ issues: page([issue("SEED-2", "implementing")]) }, { issues: page([]) }],
    Comments: [
      {
        issues: {
          nodes: [
            { identifier: "SEED-1", comments: page([]) },
            { identifier: "SEED-2", comments: page(comments) },
          ],
        },
      },
    ],
  };
}
function clock() {
  let instant = t0;
  const pending = new Map<() => void, number>();
  return {
    now: () => new Date(instant),
    set: (callback: () => void, delay: number) => {
      pending.set(callback, delay);
      return () => pending.delete(callback);
    },
    advance(at: string) {
      instant = at;
    },
    fire() {
      const callback = pending.keys().next().value;
      assert.ok(callback);
      pending.delete(callback);
      callback();
    },
  };
}

test("two recorded readings append only changed tickets, phase, report and question; cold reads deduplicate", async () => {
  const response = recorded({
    ...initial([comment("report-a", "Agent status: implementing — Planting")]),
    Changed: [{ issues: page([issue("SEED-2", "blocked")]) }],
    ChangedComments: [
      {
        comments: page([
          {
            ...comment("question-a", "Agent status: blocked — question: Add shade?", t1),
            issue: { identifier: "SEED-2" },
          },
        ]),
      },
    ],
  });
  const c = clock();
  const store = new EventStore(":memory:");
  const tracker = linearTracker({
    project: "orchard",
    rootId: "SEED-1",
    phaseGroup: "Fleet phase",
    secrets: async () => "fake-linear-key",
    fetch: response.fetch,
    now: c.now,
  });
  const poller = new TrackerPoller({ project: "orchard", tracker, store, clock: c });
  try {
    await poller.readNow();
    const cursor = store.readSince(0).at(-1)?.seq ?? 0;
    assert.equal(fold(store.readSince(0)).projects.orchard?.sessions[0]?.reason, "Planting");
    c.advance(t1);
    await poller.readNow();
    assert.deepEqual(
      store.readSince(cursor).map((e) => e.kind),
      ["ticket.phase-changed", "ticket.report-posted", "inbox.opened", "ticket.seen"],
    );
    const state = fold(store.readSince(0)).projects.orchard;
    assert.equal(state?.sessionsByState.blocked[0]?.reason, "question: Add shade?");
    assert.equal(state?.inbox[0]?.body, "Add shade?");
    assert.deepEqual(response.calls.find((call) => call.operation === "Changed")?.variables.filter, {
      updatedAt: { gt: "2030-01-01T09:59:59.000Z" },
      or: [{ id: { in: ["uuid-SEED-1", "uuid-SEED-2"] } }, { parent: { id: { in: ["uuid-SEED-1", "uuid-SEED-2"] } } }],
    });
    store.append({
      project: "orchard",
      kind: "inbox.answered",
      at: t1,
      actor: "Mira",
      payload: { id: state?.inbox[0]?.id ?? "", answer: "Add shade" },
    });
    const restartResponses = initial([
      comment("report-a", "Agent status: implementing — Planting"),
      comment("question-a", "Agent status: blocked — question: Add shade?", t1),
    ]);
    restartResponses.Children[0] = { issues: page([issue("SEED-2", "blocked")]) };
    const restart = new TrackerPoller({
      project: "orchard",
      store,
      clock: c,
      tracker: linearTracker({
        project: "orchard",
        rootId: "SEED-1",
        phaseGroup: "Fleet phase",
        secrets: async () => "fake-linear-key",
        fetch: recorded(restartResponses).fetch,
        now: c.now,
      }),
    });
    const before = store.readSince(0).length;
    await restart.readNow();
    assert.equal(store.readSince(0).length, before);
    assert.deepEqual(fold(store.readSince(0)).projects.orchard?.inbox, []);
    restart.stop();
  } finally {
    poller.stop();
    store.close();
  }
});

test("edited questions replace the old inbox item, notes preserve it, and an answer closes it", async () => {
  const edited = {
    ...comment("ask", "Agent status: blocked — question: More shade?", t0),
    updatedAt: t1,
    issue: { identifier: "SEED-2" },
  };
  const responses = initial([comment("ask", "Agent status: blocked — question: Shade?")]);
  responses.Children[0] = { issues: page([issue("SEED-2", "blocked")]) };
  const source = recorded({
    ...responses,
    Changed: Array.from({ length: 3 }, () => ({ issues: page([]) })),
    ChangedComments: [
      { comments: page([edited]) },
      {
        comments: page([
          {
            ...comment("note", "Agent status: blocked — note: Still investigating", t1),
            issue: { identifier: "SEED-2" },
          },
        ]),
      },
      {
        comments: page([
          {
            ...comment("reply", "Agent status: blocked — answer: Add shade", "2030-01-01T10:02:00.000Z"),
            issue: { identifier: "SEED-2" },
          },
        ]),
      },
    ],
  });
  const store = new EventStore(":memory:");
  const c = clock();
  const poller = new TrackerPoller({
    project: "orchard",
    store,
    clock: c,
    tracker: linearTracker({
      project: "orchard",
      rootId: "SEED-1",
      phaseGroup: "Fleet phase",
      secrets: async () => "fake-key",
      fetch: source.fetch,
      now: c.now,
    }),
  });
  try {
    await poller.readNow();
    const old = fold(store.readSince(0)).projects.orchard?.inbox[0]?.id;
    assert.ok(old);
    await poller.readNow();
    const inbox = fold(store.readSince(0)).projects.orchard?.inbox;
    assert.equal(inbox?.length, 1);
    assert.notEqual(inbox?.[0]?.id, old);
    assert.equal(inbox?.[0]?.body, "More shade?");
    await poller.readNow();
    assert.equal(fold(store.readSince(0)).projects.orchard?.inbox.length, 1);
    assert.equal(fold(store.readSince(0)).projects.orchard?.sessions[0]?.reason, "question: More shade?");
    await poller.readNow();
    assert.deepEqual(fold(store.readSince(0)).projects.orchard?.inbox, []);
  } finally {
    poller.stop();
    store.close();
  }
});

test("full and incremental reads paginate nested connections and discover a new subtree", async () => {
  const child = {
    ...issue("SEED-2"),
    labels: page([{ name: "API", parent: null }], "labels-1"),
    attachments: page([{ title: "Sketch", url: "https://example.test/sketch" }], "attachments-1"),
  };
  const newIssue = { ...issue("SEED-3", "planning"), parent: { identifier: "SEED-2" } };
  const descendant = { ...issue("SEED-4"), parent: { identifier: "SEED-3" } };
  const source = recorded({
    Root: [{ issue: issue("SEED-1") }],
    Children: [
      { issues: page([], "child-page") },
      { issues: page([child]) },
      { issues: page([]) },
      { issues: page([descendant]) },
      { issues: page([]) },
    ],
    Morelabels: [{ issue: { labels: page([{ name: "Shipping", parent: { name: "Fleet phase" } }]) } }],
    Moreattachments: [{ issue: { attachments: page([{ title: "Design", url: "https://example.test/design" }]) } }],
    Comments: [
      {
        issues: {
          nodes: [
            { identifier: "SEED-1", comments: page([]) },
            {
              identifier: "SEED-2",
              comments: page([comment("a", "Agent status: shipping — Building")], "comment-page"),
            },
          ],
        },
      },
      {
        issues: {
          nodes: [
            { identifier: "SEED-3", comments: page([]) },
            { identifier: "SEED-4", comments: page([]) },
          ],
        },
      },
    ],
    Morecomments: [{ issue: { comments: page([comment("b", "A plain comment")]) } }],
    Changed: [{ issues: page([newIssue], "changed-1") }, { issues: page([]) }],
    ChangedComments: [{ comments: page([], "changed-comments-1") }, { comments: page([]) }],
  });
  const tracker = linearTracker({
    project: "orchard",
    rootId: "SEED-1",
    phaseGroup: "Fleet phase",
    secrets: async () => "fake-key",
    fetch: source.fetch,
    now: () => new Date(t0),
  });
  const previous = await tracker.read({ signal: new AbortController().signal });
  assert.equal(previous.tickets[1]?.phase, "shipping");
  assert.equal(previous.tickets[1]?.attachments.length, 2);
  assert.deepEqual(
    previous.comments.map((comment) => comment.id),
    ["a", "b"],
  );
  const next = await tracker.read({ previous, signal: new AbortController().signal });
  assert.deepEqual(
    next.tickets.map((ticket) => ticket.id),
    ["SEED-1", "SEED-2", "SEED-3", "SEED-4"],
  );
  assert.deepEqual(
    previous.tickets.map((ticket) => ticket.id),
    ["SEED-1", "SEED-2"],
  );
  assert.deepEqual(
    source.calls.filter((call) => call.operation === "Children").map((call) => call.variables.parents),
    [["uuid-SEED-1"], ["uuid-SEED-1"], ["uuid-SEED-2"], ["uuid-SEED-3"], ["uuid-SEED-4"]],
  );
});

test("failed and non-advancing pages append nothing and retry from the last completed read", async () => {
  const source = recorded({
    ...initial(),
    Changed: [{ issues: page([issue("SEED-2", "blocked")]) }, { issues: page([issue("SEED-2", "shipping")]) }],
    ChangedComments: [{ comments: page([], "stuck") }, { comments: page([], "stuck") }, { comments: page([]) }],
  });
  const c = clock();
  const store = new EventStore(":memory:");
  const poller = new TrackerPoller({
    project: "orchard",
    store,
    clock: c,
    tracker: linearTracker({
      project: "orchard",
      rootId: "SEED-1",
      phaseGroup: "Fleet phase",
      secrets: async () => "fake-key",
      fetch: source.fetch,
      now: c.now,
    }),
  });
  try {
    await poller.readNow();
    const before = store.readSince(0);
    c.advance(t1);
    await poller.readNow();
    assert.equal(poller.status.error, "Tracker read failed");
    assert.equal(poller.status.lastCompletedAt, t0);
    assert.deepEqual(store.readSince(0), before);
    await poller.readNow();
    assert.equal(poller.status.error, null);
    assert.equal(fold(store.readSince(0)).projects.orchard?.sessions[0]?.phase, "shipping");
    for (const call of source.calls.filter((call) => call.operation === "Changed")) {
      assert.equal((call.variables.filter as { updatedAt: { gt: string } }).updatedAt.gt, "2030-01-01T09:59:59.000Z");
    }
  } finally {
    poller.stop();
    store.close();
  }
});

test("missing keys and secret-bearing transport/server failures never escape as diagnostics", async () => {
  for (const failure of ["missing", "keychain", "transport", "graphql", "json", "http"]) {
    let fetched = false;
    const tracker = linearTracker({
      project: "orchard",
      rootId: "SEED-1",
      phaseGroup: "Fleet phase",
      now: () => new Date(t0),
      secrets: async (service, project) => {
        assert.equal(service, "linear");
        assert.equal(project, "orchard");
        if (failure === "keychain") throw new Error("fake-secret-value");
        return failure === "missing" ? null : "fake-secret-value";
      },
      fetch: async (_url, init) => {
        fetched = true;
        assert.equal(new Headers(init.headers).get("Authorization"), "fake-secret-value");
        if (failure === "transport") throw new Error("fake-secret-value");
        if (failure === "json") return new Response("fake-secret-value");
        if (failure === "http") return new Response("fake-secret-value", { status: 401 });
        return Response.json({ errors: [{ message: "fake-secret-value" }] });
      },
    });
    await assert.rejects(tracker.read({ signal: new AbortController().signal }), (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fake-secret-value/);
      return true;
    });
    assert.equal(fetched, !["missing", "keychain"].includes(failure));
  }
});

test("timer exposes its schedule and gates retries until an abort-ignoring provider settles", async () => {
  const c = clock();
  const store = new EventStore(":memory:");
  let resolveLate: (reading: { startedAt: string; tickets: []; comments: [] }) => void = () => {};
  let calls = 0;
  const poller = new TrackerPoller({
    project: "orchard",
    store,
    clock: c,
    intervalMs: 10_000,
    timeoutMs: 1000,
    tracker: {
      read: async () => {
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            resolveLate = resolve;
          });
        return { startedAt: t1, tickets: [], comments: [] };
      },
    },
  });
  try {
    poller.start();
    const first = poller.readNow();
    assert.equal(first, poller.readNow());
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(poller.status.reading, true);
    c.fire(); // deadline, no real wall-clock wait
    await first;
    assert.equal(poller.status.error, "Tracker read timed out");
    assert.equal(poller.status.nextReadAt, "2030-01-01T10:00:10.000Z");
    c.advance(t1);
    c.fire(); // scheduled retry must not overlap the still-pending provider
    await poller.readNow();
    assert.equal(calls, 1);
    assert.equal(poller.status.reading, true);
    assert.equal(poller.status.error, "Tracker read timed out");
    resolveLate({ startedAt: t0, tickets: [], comments: [] });
    await setImmediate(); // yield one event-loop turn for promise adoption, not a clock wait
    assert.equal(poller.status.reading, false);
    assert.equal(poller.status.lastCompletedAt, null);
    c.fire(); // provider has settled; now a fresh read is safe
    await poller.readNow();
    assert.equal(calls, 2);
    assert.equal(poller.status.lastCompletedAt, t1);
    assert.equal(poller.status.error, null);
    poller.stop();
    assert.deepEqual(store.readSince(0), []);
    assert.equal(poller.status.nextReadAt, null);
  } finally {
    poller.stop();
    store.close();
  }
});

test("periodic full reads retire tickets that left scope without changing local claim generations", async () => {
  const first = initial([comment("ask", "Agent status: blocked — question: Shade?")]);
  first.Children[0] = { issues: page([issue("SEED-2", "blocked")]) };
  const source = recorded({
    ...first,
    Root: [{ issue: issue("SEED-1") }, { issue: issue("SEED-1") }],
    Children: [...first.Children, { issues: page([]) }],
    Comments: [...first.Comments, { issues: { nodes: [{ identifier: "SEED-1", comments: page([]) }] } }],
  });
  const c = clock();
  const store = new EventStore(":memory:");
  const poller = new TrackerPoller({
    project: "orchard",
    clock: c,
    store,
    tracker: linearTracker({
      project: "orchard",
      rootId: "SEED-1",
      phaseGroup: "Fleet phase",
      secrets: async () => "fake-key",
      fetch: source.fetch,
      now: c.now,
    }),
  });
  try {
    await poller.readNow();
    assert.equal(fold(store.readSince(0)).projects.orchard?.inbox.length, 1);
    store.append({
      project: "orchard",
      at: t0,
      actor: "Mira",
      kind: "session.claimed",
      payload: {
        ticket: "SEED-2",
        session: "local-session",
        generation: 1,
        owner: "Mira",
        runtime: "local",
        handle: "pane",
      },
    });
    c.advance("2030-01-01T10:31:00.000Z");
    await poller.readNow();
    assert.equal(source.calls.filter((call) => call.operation === "Root").length, 2);
    const result = fold(store.readSince(0)).projects.orchard;
    assert.equal(result?.tickets.find((ticket) => ticket.id === "SEED-2")?.phase, "released");
    assert.equal(result?.sessions[0]?.session, "local-session");
    assert.equal(result?.sessions[0]?.phase, "planning");
    assert.deepEqual(result?.inbox, []);
  } finally {
    poller.stop();
    store.close();
  }
});
