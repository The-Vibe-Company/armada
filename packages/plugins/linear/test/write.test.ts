import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext, TrackerProvider } from "@armada/plugin-api";
import { activate } from "../src/index.ts";

test("phase writes resolve applicable labels, preserve other labels, and refuse incomplete or failed writes", async (t) => {
  let provider: TrackerProvider | undefined;
  activate({
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
