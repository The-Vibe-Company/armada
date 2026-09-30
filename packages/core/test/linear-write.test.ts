import { describe, expect, test } from "bun:test";
import type { Fetch } from "../src/linear.ts";
import { createLinearWriter } from "../src/linear-write.ts";

/** Answers each GraphQL operation from `answers` and records what was sent. */
function graphql(answers: Record<string, unknown>) {
  const sent: { operation: string; variables: Record<string, unknown> }[] = [];
  const fetch: Fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "?";
    sent.push({ operation, variables: body.variables });
    const answer = answers[operation];
    if (answer === undefined) throw new Error(`unexpected ${operation}`);
    return Response.json(answer);
  };
  const writer = createLinearWriter({
    apiKey: "k",
    fetch,
    labels: { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" },
  });
  return { writer, sent };
}

describe("Linear write adapter", () => {
  test("reads a ticket with its labels, team workflow, claim and linked pull request", async () => {
    const { writer } = graphql({
      Ticket: {
        data: {
          issue: {
            id: "uuid-7",
            identifier: "DEMO-7",
            title: "Send a sign-in link",
            url: "https://linear.app/acme/issue/DEMO-7",
            branchName: "feature/demo-7-send-a-sign-in-link",
            description: null,
            state: { id: "st-2", type: "started" },
            team: {
              id: "team-1",
              states: {
                nodes: [
                  { id: "st-2", name: "In Progress", type: "started", position: 2 },
                  { id: "st-1", name: "Todo", type: "unstarted", position: 1 },
                ],
              },
            },
            assignee: { id: "user-1" },
            labels: {
              nodes: [
                { id: "l-1", name: "implementing", parent: { name: "Agent phase" } },
                { id: "l-2", name: "Codex", parent: { name: "Agent runtime" } },
              ],
            },
            attachments: { nodes: [{ title: "PR", url: "https://github.com/acme/widgets/pull/9" }] },
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "c-1",
                  createdAt: "2026-03-04T09:00:00.000Z",
                  body: "Agent status: planning — claimed\n\nAgent claim — runtime: Codex · session: ws-1/s-2 · branch: b · started: t",
                  user: { name: "Ada" },
                },
              ],
            },
          },
        },
      },
    });
    const t = await writer.readTicket("DEMO-7");
    expect(t).toMatchObject({
      uuid: "uuid-7",
      statusType: "started",
      teamId: "team-1",
      agentPhase: "implementing",
      agentRuntime: "Codex",
      states: [{ name: "Todo" }, { name: "In Progress" }],
      prs: [{ number: 9, repo: "acme/widgets" }],
    });
    expect(t?.comments[0]?.claim?.session).toBe("ws-1/s-2");
    expect(t?.comments[0]?.status?.phase).toBe("planning");
  });

  test("writes state, assignee and label changes in one issueUpdate; team labels shadow workspace ones", async () => {
    const { writer, sent } = graphql({
      Update: { data: { issueUpdate: { success: true } } },
      GroupLabels: {
        data: {
          issueLabels: {
            nodes: [
              { id: "w-planning", name: "planning", team: null },
              { id: "t-planning", name: "planning", team: { id: "team-1" } },
              { id: "o-planning", name: "planning", team: { id: "team-2" } },
            ],
          },
        },
      },
      Ticket: { errors: [{ message: "Entity not found: Issue" }] },
    });
    await writer.updateTicket("uuid-7", {
      stateId: "st-2",
      assigneeId: "user-1",
      addLabelIds: ["l-new"],
      removeLabelIds: ["l-old"],
    });
    expect(sent[0]).toEqual({
      operation: "Update",
      variables: {
        id: "uuid-7",
        input: { stateId: "st-2", assigneeId: "user-1", addedLabelIds: ["l-new"], removedLabelIds: ["l-old"] },
      },
    });
    expect(await writer.groupLabels("Agent phase", "team-1")).toEqual([
      { id: "t-planning", name: "planning", group: "Agent phase" },
    ]);
    expect(await writer.readTicket("DEMO-404")).toBeNull();
  });
});
