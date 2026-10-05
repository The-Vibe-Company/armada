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
  test("creates a child issue and updates its title through the only write adapter", async () => {
    const { writer, sent } = graphql({
      CreateIssue: {
        data: {
          issueCreate: {
            success: true,
            issue: { id: "uuid-8", identifier: "DEMO-8", url: "https://linear.app/acme/issue/DEMO-8" },
          },
        },
      },
      Update: { data: { issueUpdate: { success: true } } },
    });
    const input = { teamId: "team-1", parentId: "uuid-root", title: "Spec 3 — Images", description: "## In short" };
    expect(await writer.createIssue(input)).toEqual({
      uuid: "uuid-8",
      id: "DEMO-8",
      url: "https://linear.app/acme/issue/DEMO-8",
    });
    await writer.updateTicket("uuid-8", { title: "Spec 4 — Images" });
    expect(sent).toEqual([
      { operation: "CreateIssue", variables: { input } },
      { operation: "Update", variables: { id: "uuid-8", input: { title: "Spec 4 — Images" } } },
    ]);
  });
  test("a create refused or timed out is never replayed", async () => {
    const { writer } = graphql({ CreateIssue: { data: { issueCreate: { success: false, issue: null } } } });
    const input = { teamId: "team-1", parentId: "uuid-root", title: "Spec 1 — Login", description: "## In short" };
    await expect(writer.createIssue(input)).rejects.toThrow("refused to create");
    let calls = 0;
    const timed = createLinearWriter({
      apiKey: "synthetic",
      labels: { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" },
      fetch: async () => {
        calls++;
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    await expect(timed.createIssue(input)).rejects.toThrow("no answer within 30 s");
    expect(calls).toBe(1);
  });
  test("a timed-out query retries once; comment mutations are never replayed", async () => {
    let calls = 0;
    const writer = createLinearWriter({
      apiKey: "synthetic-key",
      labels: { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" },
      fetch: async () => {
        calls++;
        if (calls === 2) return Response.json({ data: { viewer: { id: "person-1", name: "Olive" } } });
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    expect(await writer.viewer()).toEqual({ id: "person-1", name: "Olive" });
    expect(calls).toBe(2);
    await expect(writer.comment("ticket-1", "Progress")).rejects.toThrow("no answer within 30 s");
    expect(calls).toBe(3);
  });

  test("reads a ticket with its labels (phase names in any case), team workflow, claim and linked pull request", async () => {
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
                { id: "l-1", name: "Implementing", parent: { name: "Agent phase" } },
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

  test("reads every label and comment past the first page, so a claim routes on all labels and sees every claim", async () => {
    const page = (hasNextPage: boolean, endCursor: string | null) => ({ hasNextPage, endCursor });
    const claim = (id: string, createdAt: string, session: string) => ({
      id,
      createdAt,
      body: `Agent claim — runtime: Codex · session: ${session} · branch: b · started: t`,
      user: { name: "Ada" },
    });
    const answers = {
      Ticket: {
        data: {
          issue: {
            id: "uuid-7",
            identifier: "DEMO-7",
            title: "Send a sign-in link",
            url: "https://linear.app/acme/issue/DEMO-7",
            branchName: null,
            description: null,
            state: { id: "st-2", type: "started" },
            team: {
              id: "team-1",
              states: { nodes: [{ id: "st-2", name: "In Progress", type: "started", position: 2 }] },
            },
            assignee: null,
            labels: { pageInfo: page(true, "l-50"), nodes: [{ id: "l-1", name: "Web", parent: null }] },
            attachments: { pageInfo: page(false, null), nodes: [] },
            comments: { pageInfo: page(true, "c-100"), nodes: [claim("c-2", "2026-03-04T09:00:00.000Z", "ws-2")] },
          },
        },
      },
      MoreTicketLabels: {
        data: {
          issue: {
            labels: {
              pageInfo: page(false, null),
              nodes: [{ id: "l-51", name: "Implementing", parent: { name: "Agent phase" } }],
            },
          },
        },
      },
      MoreTicketComments: {
        data: {
          issue: {
            comments: { pageInfo: page(false, null), nodes: [claim("c-1", "2026-03-04T08:00:00.000Z", "ws-1")] },
          },
        },
      },
    };
    const { writer, sent } = graphql(answers);
    const t = await writer.readTicket("DEMO-7");
    expect(sent.map((s) => [s.operation, s.variables.after ?? null])).toEqual([
      ["Ticket", null],
      ["MoreTicketLabels", "l-50"],
      ["MoreTicketComments", "c-100"],
    ]);
    expect([t?.agentPhase, t?.commentsTruncated, t?.warnings]).toEqual(["implementing", false, []]);
    expect(t?.comments.map((c) => c.claim?.session)).toEqual(["ws-2", "ws-1"]);

    // A page Linear refuses leaves the ticket marked incomplete, so claim refuses it.
    const refused = { errors: [{ message: "Query too complex" }] };
    const partial = graphql({ ...answers, MoreTicketLabels: refused, MoreTicketComments: refused });
    const cut = await partial.writer.readTicket("DEMO-7");
    expect([cut?.labelsTruncated, cut?.commentsTruncated, cut?.warnings.length]).toEqual([true, true, 2]);
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
