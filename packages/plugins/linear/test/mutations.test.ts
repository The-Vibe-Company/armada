import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext, PluginEvent, TrackerProvider } from "@armada/plugin-api";
import { activate } from "../src/index.ts";
import { LinearBudget } from "../src/linear/budget.ts";
import { LinearRateLimitError } from "../src/linear/errors.ts";
import { linearTracker } from "../src/linear/index.ts";
import { page, recorded, t1 } from "./support/program.ts";

const root = { id: "root", team: { id: "team", states: page([{ id: "active", type: "started", position: 0 }]) } };
const label = (id: string, name: string, team: string | null = null) => ({
  id,
  name,
  parent: null,
  team: team ? { id: team } : null,
});
const request = {
  project: "orchard",
  title: "Plant trees",
  description: "## Plan\n\nPlant two oaks.",
  labels: ["ready"],
};
function setup(responses: Record<string, unknown[]>, budget?: LinearBudget) {
  const recording = recorded(responses);
  const tracker = linearTracker({
    project: "orchard",
    rootId: "SEED-1",
    phaseGroup: "Fleet phase",
    now: () => new Date(t1),
    secrets: async () => "synthetic-key",
    fetch: recording.fetch,
    budget,
  });
  return { tracker, calls: recording.calls };
}

test("creates under the root, resolves team labels, and reuses an exact recent descendant in one page", async () => {
  const existing = {
    id: "new",
    identifier: "SEED-3",
    url: "https://linear.example/SEED-3",
    title: request.title,
    description: request.description,
    createdAt: t1,
    parent: { id: "spec", parent: { id: "root" } },
  };
  const { tracker, calls } = setup({
    MutationRoot: [{ issue: root }],
    TicketLabels: [
      {
        issueLabels: page([
          label("workspace", "ready"),
          label("foreign", "ready", "other"),
          label("team-ready", "ready", "team"),
        ]),
      },
    ],
    RecentTickets: [
      { issues: page([]) },
      {
        issues: page(
          [
            { ...existing, parent: { id: "foreign-root" } },
            { ...existing, description: "Different" },
            { ...existing, createdAt: "2030-01-01T08:00:00.000Z" },
            existing,
          ],
          "do-not-follow",
        ),
      },
    ],
    CreateTicket: [{ issueCreate: { success: true, issue: existing } }],
  });
  assert.equal(typeof tracker.create, "function");
  assert.deepEqual(await tracker.create(request), { id: "SEED-3", url: existing.url });
  assert.deepEqual(calls.find((call) => call.operation === "CreateTicket")?.variables, {
    input: {
      teamId: "team",
      title: request.title,
      description: request.description,
      parentId: "root",
      labelIds: ["team-ready"],
    },
  });
  assert.deepEqual(await tracker.create(request), { id: "SEED-3", url: existing.url });
  assert.equal(calls.filter((call) => call.operation === "CreateTicket").length, 1);
  assert.equal(calls.filter((call) => call.operation === "MutationRoot").length, 1);
  assert.equal(calls.filter((call) => call.operation === "RecentTickets").length, 2);
});

test("updates title, Markdown, parent, state and label deltas without dropping a phase, and directs blockers toward the ticket", async () => {
  const { tracker, calls } = setup({
    EditTicket: [
      {
        issue: {
          id: "target",
          team: root.team,
          labels: page([label("phase", "implementing"), label("old", "old"), label("keep", "keep")]),
          inverseRelations: page([]),
        },
      },
    ],
    TicketLabels: [{ issueLabels: page([label("new", "new")]) }],
    UpdateTicket: [{ issueUpdate: { success: true } }],
    AddBlocker: [{ issueRelationCreate: { success: true } }],
  });
  assert.equal(typeof tracker.update, "function");
  await tracker.update({
    project: "orchard",
    ticket: "SEED-2",
    patch: {
      title: "New title",
      description: "**Markdown**",
      parent: "SEED-4",
      state: "started",
      labels: ["implementing", "keep", "new"],
      blockers: ["SEED-5"],
    },
  });
  assert.deepEqual(calls.find((call) => call.operation === "UpdateTicket")?.variables, {
    id: "target",
    input: {
      title: "New title",
      description: "**Markdown**",
      parentId: "SEED-4",
      stateId: "active",
      addedLabelIds: ["new"],
      removedLabelIds: ["old"],
    },
  });
  assert.deepEqual(calls.find((call) => call.operation === "AddBlocker")?.variables, {
    input: { issueId: "SEED-5", relatedIssueId: "target", type: "blocks" },
  });
});

test("missing labels and a paused credential refuse before any mutation, with useful reasons", async () => {
  const { tracker, calls } = setup({
    MutationRoot: [{ issue: root }],
    RecentTickets: [{ issues: page([]) }],
    TicketLabels: [{ issueLabels: page([]) }],
  });
  assert.equal(typeof tracker.create, "function");
  await assert.rejects(tracker.create(request), /label.*ready/i);
  assert.equal(
    calls.some((call) => call.operation === "CreateTicket"),
    false,
  );
  const budget = new LinearBudget(() => new Date(t1));
  const paused = setup({}, budget);
  budget.pause(new Headers({ "retry-after": "60" }));
  for (const action of [
    () => paused.tracker.create(request),
    () => paused.tracker.update({ project: "orchard", ticket: "SEED-2", patch: { title: "Changed" } }),
  ])
    await assert.rejects(action(), /paused.*2030-01-01T10:02:00.000Z/);
  assert.equal(paused.calls.length, 0);
});

test("create and update honor cancellation/write fences and refuse API failures without attempting subsequent writes", async () => {
  for (const operation of ["create", "update"] as const) {
    for (const mode of ["abort", "fence", "refused", "blocker-refused"] as const) {
      const { tracker, calls } = setup({
        MutationRoot: [{ issue: root }],
        RecentTickets: [{ issues: page([]) }],
        EditTicket: [{ issue: { id: "target", team: root.team, labels: page([]), inverseRelations: page([]) } }],
        CreateTicket: [
          {
            issueCreate: {
              success: mode !== "refused",
              issue: { id: "target", identifier: "SEED-3", url: "https://linear.example/SEED-3" },
            },
          },
        ],
        UpdateTicket: [{ issueUpdate: { success: mode !== "refused" } }],
        AddBlocker: [{ issueRelationCreate: { success: false } }],
      });
      const shared = {
        signal: mode === "abort" ? AbortSignal.abort() : undefined,
        beforeWrite:
          mode === "fence"
            ? () => {
                throw new Error("Coordinator stopped");
              }
            : undefined,
      };
      const action =
        operation === "create"
          ? () => tracker.create({ ...request, ...shared, labels: [], blockers: ["SEED-5"] })
          : () =>
              tracker.update({
                project: "orchard",
                ticket: "SEED-2",
                ...shared,
                patch: { title: "Changed", blockers: ["SEED-5"] },
              });
      await assert.rejects(
        action(),
        mode === "abort"
          ? /abort/i
          : mode === "fence"
            ? /Coordinator stopped/
            : mode === "refused"
              ? /Linear refused ticket/
              : /Linear refused blocker.*SEED-5/,
      );
      assert.equal(
        calls.some((call) => call.operation === "AddBlocker"),
        mode === "blocker-refused",
      );
      if (mode === "abort" || mode === "fence")
        assert.equal(
          calls.some((call) => call.operation === "CreateTicket" || call.operation === "UpdateTicket"),
          false,
        );
      assert.equal(tracker.budget?.snapshot("orchard").requests, calls.length);
    }
  }
});

test("workflow state types map on create and update, explicit parents and blocker removals reach Linear", async () => {
  for (const type of ["backlog", "unstarted", "started", "completed", "canceled"] as const) {
    const team = {
      id: "team",
      states: page([
        { id: "later", type, position: 2 },
        { id: "chosen", type, position: 1 },
      ]),
    };
    const { tracker, calls } = setup({
      MutationRoot: [{ issue: { ...root, team } }],
      RecentTickets: [{ issues: page([]) }],
      CreateTicket: [
        {
          issueCreate: {
            success: true,
            issue: { id: "new", identifier: "SEED-3", url: "https://linear.example/SEED-3" },
          },
        },
      ],
      EditTicket: [
        {
          issue: {
            id: "new",
            team,
            inverseRelations: page([
              { id: "relation", type: "blocks", issue: { identifier: "SEED-5" } },
              { id: "related", type: "related", issue: { identifier: "SEED-6" } },
            ]),
          },
        },
      ],
      UpdateTicket: [{ issueUpdate: { success: true } }],
      RemoveBlocker: [{ issueRelationDelete: { success: true } }],
    });
    await tracker.create({ ...request, labels: [], state: type, parent: "SEED-4" });
    await tracker.update({ project: "orchard", ticket: "SEED-3", patch: { state: type, parent: null, blockers: [] } });
    assert.deepEqual(calls.find((call) => call.operation === "CreateTicket")?.variables, {
      input: {
        title: request.title,
        description: request.description,
        teamId: "team",
        parentId: "SEED-4",
        stateId: "chosen",
        labelIds: [],
      },
    });
    assert.deepEqual(calls.find((call) => call.operation === "UpdateTicket")?.variables, {
      id: "new",
      input: { stateId: "chosen", parentId: null },
    });
    assert.deepEqual(
      calls.filter((call) => call.operation === "RemoveBlocker").map((call) => call.variables),
      [{ id: "relation" }],
    );
  }
});

test("a dedup hit finishes requested blockers after a partial create without removing other relations", async () => {
  const existing = {
    id: "new",
    identifier: "SEED-3",
    url: "https://linear.example/SEED-3",
    title: request.title,
    description: request.description,
    createdAt: t1,
    parent: { id: "root" },
  };
  const { tracker, calls } = setup({
    MutationRoot: [{ issue: root }],
    RecentTickets: [{ issues: page([]) }, { issues: page([existing]) }],
    CreateTicket: [{ issueCreate: { success: true, issue: existing } }],
    AddBlocker: [{ issueRelationCreate: { success: false } }, { issueRelationCreate: { success: true } }],
    TicketBlockers: [
      { issue: { inverseRelations: page([{ id: "keep-relation", type: "blocks", issue: { identifier: "SEED-6" } }]) } },
    ],
  });
  const input = { ...request, labels: [], blockers: ["SEED-5"] };
  await assert.rejects(tracker.create(input), /Linear refused blocker/);
  assert.deepEqual(await tracker.create(input), { id: "SEED-3", url: existing.url });
  assert.equal(calls.filter((call) => call.operation === "CreateTicket").length, 1);
  assert.equal(calls.filter((call) => call.operation === "RecentTickets").length, 2);
  assert.deepEqual(
    calls.filter((call) => call.operation === "AddBlocker").map((call) => call.variables),
    [
      { input: { issueId: "SEED-5", relatedIssueId: "new", type: "blocks" } },
      { input: { issueId: "SEED-5", relatedIssueId: "new", type: "blocks" } },
    ],
  );
  assert.equal(
    calls.some((call) => call.operation === "RemoveBlocker"),
    false,
  );
});

test("mutation requests and a mutation-triggered pause survive restart before the next poll", async (t) => {
  const events: PluginEvent[] = [];
  const recording = recorded({ MutationRoot: [{ issue: root }], RecentTickets: [{ issues: page([]) }] });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(JSON.parse(String(init.body)).query)?.[1];
    if (operation === "CreateTicket") return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    return recording.fetch(url, init);
  });
  function boot() {
    let provider: TrackerProvider | undefined;
    activate({
      config: { tracker: { linear: { projects: { orchard: { programRoot: "SEED-1" } } } } },
      events: {
        read: async () => events,
        append: async (event: Omit<PluginEvent, "seq">) => {
          const stored = { ...event, seq: events.length + 1 };
          events.push(stored);
          return stored;
        },
      },
      secrets: { get: async () => "synthetic-key" },
      register: {
        tracker: (_kind: string, value: TrackerProvider) => {
          provider = value;
        },
      },
      log: { info() {}, error() {} },
    } as unknown as PluginContext);
    assert.ok(provider?.create);
    assert.ok(provider.update);
    return provider as TrackerProvider & Required<Pick<TrackerProvider, "create" | "update">>;
  }
  const first = boot();
  let until = "";
  await assert.rejects(first.create({ ...request, labels: [] }), (error: unknown) => {
    assert.ok(error instanceof LinearRateLimitError);
    until = error.until;
    return true;
  });
  const last = events.filter((event) => event.kind === "coordinator.checkpoint").at(-1);
  const checkpoint = (last?.payload as { checkpoint?: unknown } | undefined)?.checkpoint as
    | { usage?: { requests: number; pausedUntil: string }; cursor?: unknown }
    | undefined;
  assert.equal(checkpoint?.usage?.requests, 3);
  assert.equal(checkpoint?.usage?.pausedUntil, until);
  assert.equal(checkpoint?.cursor, undefined, "mutation accounting never overwrites the reader cursor");
  const before = recording.calls.length;
  const restarted = boot();
  for (const action of [
    () => restarted.create({ ...request, labels: [] }),
    () => restarted.update({ project: "orchard", ticket: "SEED-3", patch: { title: "Changed" } }),
  ])
    await assert.rejects(action(), (error: unknown) => error instanceof LinearRateLimitError && error.until === until);
  assert.deepEqual(await restarted.read({ project: "orchard" }), { pausedUntil: until });
  assert.equal(recording.calls.length, before);
});
