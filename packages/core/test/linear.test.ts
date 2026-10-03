import { describe, expect, test } from "bun:test";
import {
  type Fetch,
  fetchProgram,
  fetchProgramChanges,
  fetchProgramIssue,
  LINEAR_ENDPOINT,
  parseClaim,
  parseStatusLine,
  type RawIssue,
} from "../src/linear.ts";
import { NOW, recordedFetch } from "./support.ts";

const labels = { phaseGroup: "Agent phase", runtimeGroup: "Agent runtime" };

describe("comment conventions", () => {
  test("status lines accept any dash and markdown, map legacy words, and reject unknown phases", () => {
    expect(parseStatusLine("**Agent status: shipping — PR open**\n\nmore")).toEqual({
      phase: "shipping",
      summary: "PR open",
    });
    expect(parseStatusLine("Agent status: handed-back - done")).toEqual({ phase: "ready-to-merge", summary: "done" });
    expect(parseStatusLine("Agent status: dreaming — zzz")).toBeNull();
    expect(parseStatusLine("Some other comment")).toBeNull();
    // The coordinator's answers and notes are records, not the worker's status.
    expect(parseStatusLine("Agent status: ready-to-merge — note: main moved, rebase")).toBeNull();
    expect(parseStatusLine("Agent status: blocked — answer: SQLite")).toBeNull();
    expect(parseStatusLine("Agent status: blocked — question: which store?")?.phase).toBe("blocked");
  });

  test("claims read runtime, session, branch and start", () => {
    const body = "Agent claim — runtime: Codex · session: ws-1 · branch: feature/x-1 · started: 2026-03-01T09:00:00Z";
    expect(parseClaim(body, "2026-03-01T09:01:00Z", "Grace")).toEqual({
      runtime: "Codex",
      session: "ws-1",
      branch: "feature/x-1",
      startedAt: "2026-03-01T09:00:00Z",
      profile: null,
      at: "2026-03-01T09:01:00Z",
      author: "Grace",
    });
    // Underscores stay in values, even when Linear escaped them; emphasis around them goes.
    const escaped =
      "Agent status: planning — x\n\n**Agent claim** — runtime: Codex · session: `my\\_ws/s_1\\~` · branch: _b_";
    expect(parseClaim(escaped, "t", null)).toMatchObject({ runtime: "Codex", session: "my_ws/s_1~", branch: "b" });
    expect(parseClaim("Agent claim — session: ws_1__", "t", null)?.session).toBe("ws_1__");
  });
});

describe("fetchProgram", () => {
  test("walks every page and level under the root, then reads comments of in-flight tickets only", async () => {
    const { fetch, calls } = recordedFetch();
    const program = await fetchProgram({ apiKey: "lin_test", rootId: "DEMO-1", labels, fetch, now: () => NOW });

    expect(calls.map((c) => c.operation)).toEqual(["Root", "Children", "Children", "Children", "Children", "Comments"]);
    expect(calls[2]?.variables).toMatchObject({ parents: ["uuid-demo-1"], after: "c1" });
    expect(calls.every((c) => c.authorization === "lin_test")).toBe(true);
    expect(calls.at(-1)?.variables.ids).toEqual(["uuid-demo-2", "uuid-demo-11", "uuid-demo-16", "uuid-demo-18"]);

    expect(program.issues).toHaveLength(13);
    const byId = new Map(program.issues.map((i) => [i.id, i]));
    expect(byId.get("DEMO-11")).toMatchObject({
      agentPhase: "implementing",
      agentRuntime: "Claude Code",
      labels: ["implementing", "Claude Code", "ready-for-agent"],
      blockedBy: [{ id: "DEMO-10", statusType: "completed" }],
      prs: [{ number: 7, repo: "acme/widgets", url: "https://github.com/acme/widgets/pull/7" }],
    });
    // A PR URL in the description counts as a link.
    expect(byId.get("DEMO-18")?.prs.map((p) => p.number)).toEqual([9]);
    expect(program.comments.map((c) => [c.issueId, c.status?.phase ?? null, c.claim?.session ?? null])).toEqual([
      ["DEMO-18", "ready-to-merge", null],
      ["DEMO-11", "implementing", null],
      ["DEMO-11", null, "ws-11"],
      ["DEMO-16", "shipping", null],
      ["DEMO-18", null, "ws-18"],
    ]);
  });

  test("retries without the delegate field when the schema rejects it", async () => {
    const recorded = recordedFetch();
    const queries: string[] = [];
    const fetch: typeof recorded.fetch = async (url, init) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      queries.push(query);
      if (queries.length === 1)
        return Response.json(
          { errors: [{ message: 'Cannot query field "delegate" on type "Issue".' }] },
          { status: 400 },
        );
      return recorded.fetch(url, init);
    };
    const program = await fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch });
    expect(program.issues).toHaveLength(13);
    expect(queries.slice(1).some((q) => q.includes("delegate"))).toBe(false);
  });

  test("relations longer than one page are read to the end, so a blocker on the last page still counts", async () => {
    const relation = (n: number, type = "blocks", state = "completed") => ({
      type,
      issue: { identifier: `DEMO-${n}`, state: { type: state } },
    });
    const page = (nodes: unknown[], endCursor: string | null) => ({
      data: { issue: { inverseRelations: { pageInfo: { hasNextPage: !!endCursor, endCursor }, nodes } } },
    });
    const { fetch, calls } = recordedFetch({
      linear: (r) => {
        const kid = r.Children[2]?.data.issues.nodes.find((n) => n.identifier === "DEMO-13");
        if (!kid) throw new Error("fixture has no DEMO-13");
        // First page as the tree query returns it: 50 relations, one of them a blocker.
        (kid.inverseRelations.nodes as unknown[]).push(
          ...Array.from({ length: 49 }, (_, k) => relation(200 + k, "related")),
        );
        Object.assign(kid.inverseRelations.pageInfo, { hasNextPage: true, endCursor: "r1" });
        (r as Record<string, unknown[]>).MoreRelations = [
          page(
            Array.from({ length: 100 }, (_, k) => relation(300 + k)),
            "r2",
          ),
          page([...Array.from({ length: 19 }, (_, k) => relation(400 + k)), relation(499, "blocks", "started")], null),
        ];
      },
    });
    const program = await fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch });

    expect(calls.filter((c) => c.operation === "MoreRelations").map((c) => c.variables)).toEqual([
      { id: "DEMO-13", after: "r1" },
      { id: "DEMO-13", after: "r2" },
    ]);
    const blockedBy = program.issues.find((i) => i.id === "DEMO-13")?.blockedBy ?? [];
    expect(blockedBy).toHaveLength(1 + 100 + 20);
    expect(blockedBy).toContainEqual({ id: "DEMO-499", statusType: "started" });
    expect(program.warnings).toEqual([]);
  });

  test("a failed read of a later page is a warning that keeps what was read", async () => {
    const { fetch } = recordedFetch({
      linear: (r) => {
        const kid = r.Children[2]?.data.issues.nodes.find((n) => n.identifier === "DEMO-13");
        if (kid) Object.assign(kid.inverseRelations.pageInfo, { hasNextPage: true, endCursor: "r1" });
        (r as Record<string, unknown[]>).MoreRelations = [{ errors: [{ message: "Query too complex" }] }];
      },
    });
    const program = await fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch });
    expect(program.warnings).toEqual([
      "DEMO-13: could not read all its relations (Linear API: Query too complex); some may be missing",
    ]);
    expect(program.issues.find((i) => i.id === "DEMO-13")?.blockedBy).toEqual([
      { id: "DEMO-10", statusType: "completed" },
    ]);
  });

  test("Linear unreachable on a later page fails the read instead of warning once per issue", async () => {
    const recorded = recordedFetch({
      linear: (r) => {
        const kid = r.Children[2]?.data.issues.nodes.find((n) => n.identifier === "DEMO-13");
        if (kid) Object.assign(kid.inverseRelations.pageInfo, { hasNextPage: true, endCursor: "r1" });
      },
    });
    const fetch: Fetch = async (url, init) => {
      if (String(init.body).includes("query MoreRelations"))
        throw new DOMException("The operation timed out.", "TimeoutError");
      return recorded.fetch(url, init);
    };
    await expect(fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch })).rejects.toThrow(
      "Linear API unreachable: no answer within 10 s; failed after 2 attempts (one retry)",
    );
  });

  test("a request with no answer before the timeout fails naming Linear", async () => {
    // Simulates the abort AbortSignal.timeout raises, without waiting for it.
    const timedOut: Fetch = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    await expect(fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch: timedOut })).rejects.toThrow(
      "Linear API unreachable: no answer within 10 s; failed after 2 attempts (one retry)",
    );
  });

  test("a missing program root is an error naming it", async () => {
    const { fetch } = recordedFetch({
      linear: (r) => {
        r.Root = [{ data: { issue: null } }] as never;
      },
    });
    await expect(fetchProgram({ apiKey: "k", rootId: "DEMO-404", labels, fetch })).rejects.toThrow(
      "program root DEMO-404 not found",
    );
  });

  test("phase and runtime labels are read only inside the configured groups", async () => {
    const { fetch } = recordedFetch();
    const program = await fetchProgram({
      apiKey: "k",
      rootId: "DEMO-1",
      labels: { phaseGroup: "Robot phase", runtimeGroup: "Robot runtime" },
      fetch,
    });
    expect(program.issues.filter((i) => i.agentPhase || i.agentRuntime)).toEqual([]);
  });
});

describe("fetchProgramChanges", () => {
  const raw = (identifier: string, parent: string, over: Partial<RawIssue> = {}): RawIssue => ({
    id: `uuid-${identifier.toLowerCase()}`,
    identifier,
    title: identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    description: null,
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:01:00.000Z",
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    state: { name: "Backlog", type: "backlog" },
    assignee: null,
    delegate: null,
    parent: { identifier: parent },
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    attachments: { pageInfo: { hasNextPage: false }, nodes: [] },
    inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  });
  const phase = (name: string) => ({
    pageInfo: { hasNextPage: false },
    nodes: [{ name, parent: { name: "Agent phase" } }],
  });
  const started = { name: "In Progress", type: "started" };
  const page = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

  test("reads only what changed since, what a webhook named and new subtrees, then merges it into the last reading", async () => {
    const previous = await fetchProgram({
      apiKey: "k",
      rootId: "DEMO-1",
      labels,
      fetch: recordedFetch().fetch,
      now: () => NOW,
    });
    const calls: { operation: string; filter: Record<string, unknown> }[] = [];
    const fetch: Fetch = async (url, init) => {
      expect(url).toBe(LINEAR_ENDPOINT);
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: { filter?: Record<string, unknown>; ids?: string[] };
      };
      const operation = body.query.match(/query\s+(\w+)/)?.[1] ?? "?";
      const filter = body.variables.filter ?? { ids: body.variables.ids };
      calls.push({ operation, filter });
      const json = JSON.stringify(filter);
      if (operation === "Changed") {
        // Updated since: DEMO-11 moved to shipping, and DEMO-30 is new under the root.
        if ("updatedAt" in filter)
          return Response.json({
            data: {
              issues: page([
                raw("DEMO-11", "DEMO-2", { state: started, labels: phase("shipping") }),
                raw("DEMO-30", "DEMO-1", { state: started, labels: phase("planning") }),
              ]),
            },
          });
        // Named by a webhook (a relation or an attachment changed, which leaves its update time alone).
        // The other one is the new parent of a ticket moved out of the program: not read into it.
        if (json.includes('"id":{"in":["uuid-demo-12","uuid-other-5"]}'))
          return Response.json({
            data: { issues: page([raw("DEMO-12", "DEMO-2", { title: "Renamed" }), raw("OTHER-5", "OTHER-1")]) },
          });
        // DEMO-30's subtree.
        if (json.includes("uuid-demo-30"))
          return Response.json({ data: { issues: page([raw("DEMO-31", "DEMO-30")]) } });
        return Response.json({ data: { issues: page([]) } });
      }
      if (operation === "ChangedComments")
        return Response.json({
          data: {
            comments: page([
              {
                id: "c11-new",
                createdAt: "2026-03-04T10:02:00.000Z",
                body: "Agent status: shipping — PR open",
                user: { name: "Ada Worker" },
                issue: { identifier: "DEMO-11" },
              },
            ]),
          },
        });
      if (operation === "Comments")
        return Response.json({
          data: {
            issues: {
              nodes: [
                {
                  identifier: "DEMO-30",
                  comments: page([
                    {
                      id: "c30",
                      createdAt: "2026-03-04T10:00:30.000Z",
                      body: "Agent claim — runtime: Codex",
                      user: null,
                    },
                  ]),
                },
              ],
            },
          },
        });
      throw new Error(`unexpected ${operation}`);
    };

    const next = await fetchProgramChanges({
      apiKey: "k",
      rootId: "DEMO-1",
      labels,
      previous,
      since: "2026-03-04T09:59:00.000Z",
      touched: ["uuid-demo-12", "uuid-other-5"],
      fetch,
      now: () => new Date("2026-03-04T10:05:00.000Z"),
    });

    expect(calls.map((c) => c.operation)).toEqual([
      "Changed",
      "Changed",
      "Changed",
      "Changed",
      "ChangedComments",
      "Comments",
    ]);
    expect(calls[0]?.filter).toMatchObject({ updatedAt: { gt: "2026-03-04T09:59:00.000Z" } });
    // Comments updated since, on the tickets that were already in flight; every comment of the new one.
    expect(calls[4]?.filter).toMatchObject({ updatedAt: { gt: "2026-03-04T09:59:00.000Z" } });
    expect(calls[5]?.filter).toEqual({ ids: ["uuid-demo-30"] });

    expect(next.fetchedAt).toBe("2026-03-04T10:05:00.000Z");
    expect(next.issues).toHaveLength(previous.issues.length + 2);
    const byId = new Map(next.issues.map((i) => [i.id, i]));
    expect(byId.get("DEMO-11")?.agentPhase).toBe("shipping");
    expect(byId.get("DEMO-12")?.title).toBe("Renamed");
    expect(byId.get("DEMO-31")?.parentId).toBe("DEMO-30");
    expect(byId.has("OTHER-5")).toBe(false);
    // Unchanged tickets are kept as read.
    expect(byId.get("DEMO-18")).toEqual(previous.issues.find((i) => i.id === "DEMO-18"));
    const of = (id: string) => next.comments.filter((c) => c.issueId === id).map((c) => c.id);
    expect(of("DEMO-11")).toEqual([
      "c11-new",
      ...previous.comments.filter((c) => c.issueId === "DEMO-11").map((c) => c.id),
    ]);
    expect(of("DEMO-30")).toEqual(["c30"]);
  });
});

describe("fetchProgramIssue", () => {
  const reading = (ancestors: string[] | null) =>
    recordedFetch({
      linear: (r) => {
        const raw = structuredClone(r.Root[0]?.data.issue);
        if (!raw) throw new Error("missing synthetic issue");
        let parent: { identifier: string; parent: unknown } | null = null;
        for (const id of [...(ancestors ?? [])].reverse()) parent = { identifier: id, parent };
        Object.assign(raw, { identifier: "DEMO-99", parent });
        (r as unknown as Record<string, unknown[]>).ProgramIssue = [
          { data: { issue: ancestors === null ? null : raw } },
        ];
      },
    });
  test("one lookup verifies the current parent chain, including a fresh intermediate parent", async () => {
    const { fetch, calls } = reading(["DEMO-98", "DEMO-1"]);
    const found = await fetchProgramIssue({ apiKey: "lin_test", rootId: "DEMO-1", labels, fetch }, "DEMO-99");
    expect(found).toMatchObject({ id: "DEMO-99", parentId: "DEMO-98" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({ id: "DEMO-99" });
    expect(calls[0]?.authorization).toBe("lin_test");
  });
  test("foreign, parentless and missing tickets are refused", async () => {
    for (const ancestors of [["OTHER-1"], [], null]) {
      const { fetch } = reading(ancestors);
      expect(await fetchProgramIssue({ apiKey: "lin_test", rootId: "DEMO-1", labels, fetch }, "DEMO-99")).toBeNull();
    }
  });
  test("deep ancestry continues without rereading the ticket, and cycles are refused", async () => {
    for (const tail of ["DEMO-1", "DEMO-99"]) {
      const { fetch, calls } = recordedFetch({
        linear: (r) => {
          const raw = structuredClone(r.Root[0]?.data.issue);
          if (!raw) throw new Error("missing synthetic issue");
          type Parent = { identifier: string; parent?: Parent | null };
          let parent: Parent = { identifier: "DEMO-107" };
          for (let n = 106; n >= 100; n--) parent = { identifier: `DEMO-${n}`, parent };
          Object.assign(raw, { identifier: "DEMO-99", parent });
          const responses = r as unknown as Record<string, unknown[]>;
          responses.ProgramIssue = [{ data: { issue: raw } }];
          responses.ProgramAncestors = [
            { data: { issue: { identifier: "DEMO-107", parent: { identifier: tail, parent: null } } } },
          ];
        },
      });
      const found = await fetchProgramIssue({ apiKey: "lin_test", rootId: "DEMO-1", labels, fetch }, "DEMO-99");
      expect(found?.id ?? null).toBe(tail === "DEMO-1" ? "DEMO-99" : null);
      expect(calls.map((c) => c.operation)).toEqual(["ProgramIssue", "ProgramAncestors"]);
    }
  });
  test("Linear failures propagate instead of becoming a membership refusal", async () => {
    const { fetch } = recordedFetch({
      linear: (r) => {
        (r as unknown as Record<string, unknown[]>).ProgramIssue = [{ errors: [{ message: "service unavailable" }] }];
      },
    });
    await expect(fetchProgramIssue({ apiKey: "lin_test", rootId: "DEMO-1", labels, fetch }, "DEMO-99")).rejects.toThrow(
      "service unavailable",
    );
  });
});
