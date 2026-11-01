import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { activate } from "../src/index.ts";

const noEvents = async () => assert.fail("Tracker writes must not access host events");
const services = {
  events: { append: noEvents, read: noEvents, fold: noEvents },
  log: { info() {}, error() {} },
};

test("phase writes resolve applicable labels, preserve other labels, and refuse incomplete or failed writes", async (t) => {
  let provider: TrackerProvider | undefined;
  activate({
    ...services,
    config: { tracker: { linear: { projects: { orchard: { programRoot: "SEED-1" } } } } },
    secrets: { get: async () => "synthetic-key" },
    register: {
      tracker: (_kind: string, value: TrackerProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  let teamPhase = false;
  let incomplete = false;
  let failed = false;
  const labels = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: incomplete, endCursor: null } });
  const workspace = { id: "workspace-phase", name: "implementing", parent: { name: "Agent phase" }, team: null };
  const team = { ...workspace, id: "team-phase", team: { id: "orchard-team" } };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    assert.equal(new Headers(init.headers).get("Authorization"), "synthetic-key");
    if (request.query.includes("query WriteIssue"))
      return Response.json({
        data: {
          issue: {
            id: "uuid-seed-2",
            team: { id: "orchard-team", labels: labels(teamPhase ? [team] : []) },
            labels: labels([
              { id: "old-phase", name: "planning", parent: { name: "Agent phase" } },
              { id: "keep", name: "Urgent", parent: null },
            ]),
          },
        },
      });
    if (request.query.includes("query PhaseLabels"))
      return Response.json({
        data: {
          issueLabels: labels([
            { ...team, id: "foreign-phase", team: { id: "foreign-team" } },
            workspace,
            ...(teamPhase ? [team] : []),
          ]),
        },
      });
    return Response.json({
      data: request.query.includes("UpdatePhase")
        ? { issueUpdate: { success: !failed } }
        : { commentCreate: { success: !failed } },
    });
  });
  const mutations = () => requests.filter((r) => r.query.includes("mutation"));
  for (const scope of ["workspace", "team"]) {
    teamPhase = scope === "team";
    requests.length = 0;
    await provider.write({
      project: "orchard",
      ticket: "SEED-2",
      phase: "implementing",
      comment: "Ready for the next step.",
    });
    assert.deepEqual(
      mutations().map((r) => r.variables),
      [
        { id: "uuid-seed-2", input: { labelIds: ["keep", `${scope}-phase`] } },
        { input: { issueId: "uuid-seed-2", body: "Ready for the next step." } },
      ],
    );
  }
  incomplete = true;
  requests.length = 0;
  await assert.rejects(
    provider.write({ project: "orchard", ticket: "SEED-2", phase: "implementing" }),
    /Linear write failed/,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(mutations(), []);
  incomplete = false;
  failed = true;
  requests.length = 0;
  await assert.rejects(
    provider.write({
      project: "orchard",
      ticket: "SEED-2",
      phase: "implementing",
      comment: "Do not post after failure",
    }),
    /Linear write failed/,
  );
  assert.equal(mutations().length, 1, "failed phase change prevents the comment mutation");
});

test("a tracker write fence stops a phase mutation after its reads", async (t) => {
  let provider: TrackerProvider | undefined;
  activate({
    ...services,
    config: { tracker: { linear: { projects: { orchard: { programRoot: "SEED-1" } } } } },
    secrets: { get: async () => "synthetic-key" },
    register: {
      tracker: (_kind: string, value: TrackerProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const labels = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(request);
    if (request.query.includes("query WriteIssue"))
      return Response.json({
        data: {
          issue: {
            id: "uuid-seed-2",
            team: { id: "orchard-team" },
            labels: labels([{ id: "keep", name: "Urgent", parent: null }]),
          },
        },
      });
    if (request.query.includes("query PhaseLabels"))
      return Response.json({
        data: {
          issueLabels: labels([{ id: "phase", name: "implementing", parent: { name: "Agent phase" }, team: null }]),
        },
      });
    throw new Error("mutation must be fenced");
  });
  await assert.rejects(
    provider.write({
      project: "orchard",
      ticket: "SEED-2",
      phase: "implementing",
      beforeWrite: () => {
        throw new Error("scope closed");
      },
    }),
    /Linear write failed/,
  );
  assert.equal(requests.filter((request) => request.query.includes("mutation")).length, 0);
  assert.equal(requests.length, 2);
});

test("completed writes move the ticket to Done, remove agent labels, and replay a stable comment once", async (t) => {
  let provider: TrackerProvider | undefined;
  activate({
    ...services,
    config: {
      tracker: {
        linear: {
          projects: {
            orchard: {
              programRoot: "SEED-1",
              phaseGroup: "Agent phase",
              runtimeGroup: "Agent runtime",
              readyLabel: "ready-for-agent",
            },
          },
        },
      },
    },
    secrets: { get: async () => "synthetic-key" },
    register: {
      tracker: (_kind: string, value: TrackerProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const commentId = "00000000-0000-4000-8000-000000000001";
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  let replay = false;
  const labels = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const issue = () => ({
    id: "uuid-seed-2",
    state: { type: replay ? "completed" : "started" },
    team: {
      id: "orchard-team",
      states: {
        nodes: [
          { id: "started", name: "In Progress", type: "started", position: 1 },
          { id: "done", name: "Done", type: "completed", position: 2 },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    labels: labels(
      replay
        ? [{ id: "keep", name: "Urgent", parent: null }]
        : [
            { id: "phase", name: "ready-to-merge", parent: { name: "Agent phase" } },
            { id: "runtime", name: "codex", parent: { name: "Agent runtime" } },
            { id: "ready", name: "ready-for-agent", parent: null },
            { id: "keep", name: "Urgent", parent: null },
          ],
    ),
    comments: {
      nodes: replay ? [{ id: commentId, body: "Agent status: merged — PR #17 squash-merged." }] : [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(request);
    if (request.query.includes("query WriteIssue")) return Response.json({ data: { issue: issue() } });
    if (request.query.includes("mutation CompleteIssue"))
      return Response.json({ data: { issueUpdate: { success: true } } });
    if (request.query.includes("mutation PostComment"))
      return Response.json({ data: { commentCreate: { success: true, comment: { id: commentId } } } });
    throw new Error("unexpected Linear request");
  });
  const body = "Agent status: merged — PR #17 squash-merged.";
  await provider.write({ project: "orchard", ticket: "SEED-2", state: "completed", comment: body, commentId });
  assert.deepEqual(
    requests.filter((request) => request.query.includes("mutation")).map((request) => request.variables),
    [
      { id: "uuid-seed-2", input: { stateId: "done", removedLabelIds: ["phase", "runtime", "ready"] } },
      { input: { id: commentId, issueId: "uuid-seed-2", body } },
    ],
  );
  replay = true;
  requests.length = 0;
  await provider.write({ project: "orchard", ticket: "SEED-2", state: "completed", comment: body, commentId });
  assert.deepEqual(
    requests.filter((request) => request.query.includes("mutation")),
    [],
  );
});
