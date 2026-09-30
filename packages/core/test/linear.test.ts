import { describe, expect, test } from "bun:test";
import { type Fetch, fetchProgram, parseClaim, parseStatusLine } from "../src/linear.ts";
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
      "Linear API unreachable: no answer within 30 s",
    );
  });

  test("a request with no answer before the timeout fails naming Linear", async () => {
    // Simulates the abort AbortSignal.timeout raises, without waiting for it.
    const timedOut: Fetch = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    await expect(fetchProgram({ apiKey: "k", rootId: "DEMO-1", labels, fetch: timedOut })).rejects.toThrow(
      "Linear API unreachable: no answer within 30 s",
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
