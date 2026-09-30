import { describe, expect, test } from "bun:test";
import { loadStatus } from "../src/status.ts";
import { demoConfig, NOW, recordedFetch } from "./support.ts";

describe("loadStatus", () => {
  test("reports tickets in flight, the frontier and waiting pull requests from Linear and GitHub", async () => {
    const { fetch } = recordedFetch();
    const r = await loadStatus(demoConfig(), { linearApiKey: "k", githubToken: "t", fetch, now: () => NOW });

    expect(r.programRoot).toMatchObject({ id: "DEMO-1", title: "Widgets: sign in and share lists" });
    expect(r.sources.github).toEqual({ fetchedAt: NOW.toISOString(), error: null });
    expect(
      r.inFlight.map((t) => [t.id, t.phase, t.phaseSource, t.runtime, t.pr?.number ?? null, t.pr?.ci ?? null, t.flags]),
    ).toEqual([
      ["DEMO-18", "ready-to-merge", "label", "Codex", 9, "success", []],
      // No phase label and no assignee: phase comes from the status line; the PR is found by branch name.
      ["DEMO-16", "shipping", "status-line", null, 8, "failure", ["ci-failing", "no-assignee", "no-phase-label"]],
      ["DEMO-11", "implementing", "label", "Claude Code", 7, "pending", []],
    ]);
    expect(r.inFlight.find((t) => t.id === "DEMO-11")).toMatchObject({
      spec: "Spec 1",
      agent: "Ada Worker",
      since: "2026-03-04T09:10:00.000Z",
      lastUpdate: "2026-03-04T09:50:00.000Z",
      statusLine: { summary: "plan approved, writing the email sender" },
    });
    expect(r.frontier.map((t) => [t.id, t.readyForAgent, t.unlocks])).toEqual([
      ["DEMO-13", true, ["DEMO-14"]],
      ["DEMO-15", false, []],
    ]);
    expect(
      r.pullRequests?.map((p) => [p.number, p.ticket?.id ?? null, p.ticket?.phase ?? null, p.failingChecks]),
    ).toEqual([
      [7, "DEMO-11", "implementing", []],
      [8, "DEMO-16", "shipping", ["test"]],
      [9, "DEMO-18", "ready-to-merge", []],
      [10, null, null, []],
    ]);
  });

  test("a GitHub failure keeps the tickets and says why pull requests are missing", async () => {
    const { fetch } = recordedFetch({ github: { errors: [{ message: "Bad credentials" }] } });
    const r = await loadStatus(demoConfig(), { linearApiKey: "k", githubToken: "t", fetch, now: () => NOW });
    expect(r.pullRequests).toBeNull();
    expect(r.sources.github).toEqual({ fetchedAt: null, error: "GitHub API: Bad credentials" });
    expect(r.inFlight).toHaveLength(3);
  });

  test("without a GitHub token the tickets are still reported and pull requests are unknown", async () => {
    const { fetch, calls } = recordedFetch();
    const r = await loadStatus(demoConfig(), { linearApiKey: "k", githubToken: null, fetch, now: () => NOW });
    expect(calls.some((c) => c.url.includes("github"))).toBe(false);
    expect(r.pullRequests).toBeNull();
    expect(r.sources.github.error).toMatch(/no GitHub token/);
    expect(r.inFlight.map((t) => t.id)).toEqual(["DEMO-18", "DEMO-16", "DEMO-11"]);
    expect(r.inFlight.find((t) => t.id === "DEMO-11")?.pr).toMatchObject({ number: 7, ci: null });
  });
});
