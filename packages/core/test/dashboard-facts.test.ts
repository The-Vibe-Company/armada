import { describe, expect, test } from "bun:test";
import { fetchForge } from "../src/github.ts";
import { buildOverview, projectHealth } from "../src/overview.ts";
import { buildStatus } from "../src/status.ts";
import fixture from "./fixtures/github-pulls.json";
import { demoConfig, issue, NOW, recordedFetch } from "./support.ts";

describe("dashboard facts", () => {
  test("one recorded forge call carries files, exact totals, mergeability and completeness", async () => {
    const recorded = structuredClone(fixture);
    const first = recorded.data.repository.open.nodes[0];
    Object.assign(first ?? {}, {
      additions: 150,
      deletions: 12,
      mergeStateStatus: "BEHIND",
      files: { nodes: [{ path: "src/widget.ts", additions: 8, deletions: 3 }], pageInfo: { hasNextPage: true } },
    });
    const net = recordedFetch({ github: recorded });
    const forge = await fetchForge({
      token: "synthetic",
      repository: "acme/widgets",
      fetch: net.fetch,
      now: () => NOW,
    });
    expect(net.calls).toHaveLength(1);
    expect(forge.prs[0]).toMatchObject({
      additions: 150,
      deletions: 12,
      files: [{ path: "src/widget.ts", additions: 8, deletions: 3 }],
      filesComplete: false,
      mergeable: "MERGEABLE",
      mergeability: "behind",
    });
    expect(forge.warnings).toContain("PR #10: changed files are incomplete (first 100)");
    const report = buildStatus({
      config: demoConfig(),
      program: {
        rootId: "DEMO-1",
        fetchedAt: NOW.toISOString(),
        issues: [
          issue("DEMO-1"),
          issue("DEMO-2", { parentId: "DEMO-1", statusType: "completed" }),
          issue("DEMO-3", { parentId: "DEMO-1" }),
        ],
        comments: [],
        warnings: [],
      },
      forge,
      now: NOW,
    });
    expect(report.progress).toEqual({ done: 1, total: 2 });
    expect(report.pullRequests?.find((pr) => pr.number === 10)?.files).toEqual([
      { path: "src/widget.ts", additions: 8, deletions: 3 },
    ]);
  });

  test("a capped checks connection preserves aggregate failure even when failing names are outside the page", async () => {
    const recorded = structuredClone(fixture);
    const rollup = recorded.data.repository.open.nodes[1]?.commits.nodes[0]?.commit.statusCheckRollup;
    if (!rollup) throw new Error("missing fixture checks");
    rollup.state = "FAILURE";
    rollup.contexts.pageInfo.hasNextPage = true;
    const net = recordedFetch({ github: recorded });
    const forge = await fetchForge({
      token: "synthetic",
      repository: "acme/widgets",
      fetch: net.fetch,
      now: () => NOW,
    });
    expect(forge.prs[1]).toMatchObject({ ci: "failure", checksComplete: false });
    expect(forge.warnings).toContain("PR #9: checks are incomplete (first 50)");
    expect(net.calls).toHaveLength(1);
  });

  test("health prioritizes failures, then overdue coordinator work, then silence", () => {
    const base = { tickets: [], prs: [], inbox: [], coordinator: "active" as const, coordinatorMinutes: 10, now: NOW };
    expect(projectHealth(base)).toBe("on-track");
    expect(projectHealth({ ...base, tickets: [{ phase: "implementing", silent: true }] })).toBe("watch");
    expect(projectHealth({ ...base, tickets: [{ phase: "blocked", silent: true }] })).toBe("blocked");
    expect(projectHealth({ ...base, prs: [{ ci: "failure", mergeable: null }] })).toBe("blocked");
    expect(projectHealth({ ...base, prs: [{ ci: "success", mergeable: "CONFLICTING" }] })).toBe("blocked");
    const old = [{ createdAt: new Date(NOW.getTime() - 10 * 60_000 - 1).toISOString() }];
    expect(projectHealth({ ...base, inbox: old })).toBe("watch");
    expect(projectHealth({ ...base, inbox: old, coordinator: "idle" })).toBe("blocked");
    expect(projectHealth({ ...base, inbox: old, coordinator: "unknown" })).toBe("blocked");
    expect(
      projectHealth({ ...base, inbox: [{ createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }] }),
    ).toBe("on-track");
  });

  test("unknown legacy facts stay explicit in the overview", () => {
    const overview = buildOverview({
      projects: [
        { slug: "widgets", name: "Widgets", repository: "acme/widgets", report: null, error: null, live: null },
      ],
      live: { state: "off", error: null },
      now: NOW,
    });
    expect(overview.sessions).toEqual([]);
    expect(overview.projects[0]).toMatchObject({
      owner: null,
      progress: null,
      health: null,
      pullRequests: null,
      requests: [],
      coordinator: { state: "unknown", inboxTrack: { reads: [], idle: [] } },
    });
  });
});
