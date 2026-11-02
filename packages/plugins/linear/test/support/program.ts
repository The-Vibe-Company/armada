import assert from "node:assert/strict";
import type { LinearFetch } from "../../src/linear/index.ts";

export const t0 = "2030-01-01T10:00:00.000Z";
export const t1 = "2030-01-01T10:01:00.000Z";
export const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
export const issue = (id: string, phase: string | null = null) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `Grow ${id}`,
  description: `Full requirements for ${id}`,
  branchName: `worker/${id.toLowerCase()}`,
  inverseRelations: page<{ type: string; issue: { identifier: string; state: { type: string } } }>([]),
  url: `https://linear.example/issue/${id}`,
  updatedAt: t0,
  state: { type: phase ? "started" : "backlog" },
  assignee: { name: "Mira" },
  parent: id === "SEED-1" ? null : { identifier: "SEED-1" },
  labels: page(phase ? [{ name: phase, parent: { name: "Fleet phase" } }] : []),
  attachments: page([]),
});
export const comment = (id: string, body: string, at = t0) => ({
  id,
  body,
  createdAt: at,
  updatedAt: at,
  user: { name: "Mira" },
});
/** Synthetic recorded GraphQL responses, queued by operation (V1 support.ts pattern). */
export function recorded(responses: Record<string, unknown[]>) {
  const calls: { operation: string; variables: Record<string, unknown> }[] = [];
  const fetch: LinearFetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    calls.push({ operation, variables });
    let data = operation === "Changed" && !variables.readIssues ? {} : responses[operation]?.shift();
    if (operation === "Changed") {
      if (!variables.readIssues) data = {};
      assert.ok(data, `unexpected ${operation}`);
      const comments = variables.readComments ? responses.ChangedComments?.shift() : undefined;
      assert.ok(!variables.readComments || comments, "unexpected changed-comments page");
      data = { ...(data as object), ...(comments as object | undefined) };
    }
    assert.ok(data, `unexpected ${operation}`);
    return Response.json({ data });
  };
  return { calls, fetch };
}
export function initial(comments: unknown[] = []) {
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
