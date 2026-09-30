import { describe, expect, test } from "bun:test";
import { fetchProgram, parseClaim, parseStatusLine } from "../src/linear.ts";
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
