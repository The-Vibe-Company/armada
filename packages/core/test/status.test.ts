import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { normalizeComment } from "../src/linear.ts";
import { buildStatus, loadStatus, readStatusSources, refreshStatusSources } from "../src/status.ts";
import { DEMO_TOML, demoConfig, issue, NOW, recordedFetch } from "./support.ts";

describe("loadStatus", () => {
  test("mine filters owned work after full derivation and retains the whole frontier with launch owners", async () => {
    const launch = (ticket: string, coordinator: string) => ({
      ticket,
      coordinator,
      launchedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      tokenUsedAt: null,
      runtime: null,
      handle: null,
    });
    const options = {
      linearApiKey: "k",
      githubToken: "t",
      now: () => NOW,
      runtimeHandles: async () => [
        {
          project: "widgets",
          ticket: "DEMO-11",
          coordinator: "front",
          runtime: "conductor",
          handle: "ws/front",
          branch: null,
          claimedAt: NOW.toISOString(),
          releasedAt: null,
          profile: null,
        },
        {
          project: "widgets",
          ticket: "DEMO-18",
          coordinator: "default",
          runtime: "conductor",
          handle: "ws/default",
          branch: null,
          claimedAt: NOW.toISOString(),
          releasedAt: null,
          profile: null,
        },
      ],
      launches: async () => [launch("DEMO-13", "default"), launch("DEMO-15", "front")],
    };
    const all = await loadStatus(demoConfig(), { ...options, fetch: recordedFetch().fetch });
    const mine = await loadStatus(demoConfig(), { ...options, fetch: recordedFetch().fetch, coordinatorName: "front" });
    expect(mine.inFlight.map((ticket) => ticket.id)).toEqual(["DEMO-11"]);
    expect(mine.notStarted.map((ticket) => ticket.ticket)).toEqual(["DEMO-15"]);
    expect(mine.pendingLaunches?.map((ticket) => ticket.ticket)).toEqual(["DEMO-15"]);
    expect(mine.frontier.map((ticket) => ticket.id)).toEqual(all.frontier.map((ticket) => ticket.id));
    expect(mine.frontier.find((ticket) => ticket.id === "DEMO-13")).toMatchObject({ launchingBy: "default" });
  });

  test("a persisted stage survives a later tracker read in status JSON", async () => {
    const { fetch } = recordedFetch();
    const r = await loadStatus(demoConfig(), {
      linearApiKey: "k",
      githubToken: "t",
      fetch,
      now: () => NOW,
      latestEvents: async () => ({
        "DEMO-16": {
          kind: "report",
          phase: "shipping",
          shippingStage: "review",
          message: "review",
          runtime: null,
          handle: null,
          prUrl: null,
          at: "2026-03-04T09:40:00.000Z",
        },
      }),
    });
    expect(r.inFlight.find((t) => t.id === "DEMO-16")).toMatchObject({
      phase: "shipping",
      shippingStage: "review",
      pr: { ci: "failure" },
    });
    expect(r.pullRequests?.find((p) => p.number === 8)?.ticket?.shippingStage).toBe("review");
  });

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
      [
        "DEMO-16",
        "shipping",
        "status-line",
        null,
        8,
        "failure",
        ["silent", "ci-failing", "no-assignee", "no-phase-label"],
      ],
      // Last report 50 minutes ago: the pull request moving since then is not a report.
      ["DEMO-11", "implementing", "label", "Claude Code", 7, "pending", ["silent"]],
    ]);
    expect(r.inFlight.find((t) => t.id === "DEMO-11")).toMatchObject({
      spec: "Spec 1",
      agent: "Ada Worker",
      since: "2026-03-04T09:10:00.000Z",
      lastUpdate: "2026-03-04T09:50:00.000Z",
      lastReport: "2026-03-04T09:10:00.000Z",
      // The status comment carries the plan: one line here, the full plan one click away.
      statusLine: {
        summary: "plan approved, writing the email sender",
        url: "https://linear.app/acme/issue/DEMO-11#comment-c11b0000",
        plan: true,
      },
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
    // A project's page shows each pull request's branch.
    expect(r.pullRequests?.map((p) => p.branch)).toEqual([
      "feature/demo-11-sign-in-link",
      "feature/demo-16-reset-password",
      "feature/demo-18-expire-sessions",
      "chore/bump-deps",
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

  test("each ready ticket carries the profile its labels route it to, for the dashboard's launch picker", async () => {
    const config = parseConfig(`${DEMO_TOML}
[conductor]
default_profile = "opus"
[conductor.profiles.opus]
agent = "claude"
model = "opus-5-5"
effort = "high"
[conductor.profiles.codex]
agent = "codex"
model = "gpt-6"
effort = "high"
[[conductor.routing]]
labels = ["Ready for agent"]
profile = "codex"
`);
    const { fetch } = recordedFetch();
    const r = await loadStatus(config, { linearApiKey: "k", githubToken: null, fetch, now: () => NOW });
    expect(r.frontier.map((t) => [t.id, t.route])).toEqual([
      ["DEMO-13", { profile: "codex", why: 'rule 1 of [[conductor.routing]] (label "ready-for-agent")' }],
      ["DEMO-15", { profile: "opus", why: "conductor.default_profile (no routing rule matched)" }],
    ]);
  });
});

describe("buildStatus", () => {
  test("Herdr status explicitly names DeepSeek's OpenCode fallback, without confusing the assignee", () => {
    const config = parseConfig(`${DEMO_TOML}
[herdr.profiles.backend]
harness = "deepseek"
model = "deepseek/deepseek-reasoner"
effort = "high"
`);
    const report = buildStatus({
      config,
      program: {
        rootId: "DEMO-1",
        fetchedAt: NOW.toISOString(),
        warnings: [],
        issues: [
          issue("DEMO-1"),
          issue("DEMO-2", {
            parentId: "DEMO-1",
            agentPhase: "planning",
            agentRuntime: "Herdr",
            assignee: "Ada Worker",
          }),
        ],
        comments: [
          normalizeComment(
            {
              id: "claim-2",
              createdAt: NOW.toISOString(),
              user: { name: "Ada Worker" },
              body: "Agent claim — runtime: Herdr · session: w8/p9 · profile: backend",
            },
            "DEMO-2",
          ),
        ],
      },
      forge: null,
      now: NOW,
    });
    expect(report.inFlight[0]).toMatchObject({
      profile: "backend",
      harness: "deepseek (OpenCode + DeepSeek model)",
      agent: "Ada Worker",
    });
  });

  test("the claim's profile reason reaches status and unmatched semantic tickets have no ready route", () => {
    const config = parseConfig(
      `${DEMO_TOML}\n[conductor]\ndefault_profile = "backend"\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "m"\neffort = "high"\nwhen = "CLI, core rules and tests"\n[[conductor.routing]]\nlabels = ["api"]\nprofile = "backend"\n`,
    );
    const reason = "Mostly CLI and core rules";
    const report = buildStatus({
      config,
      program: {
        rootId: "DEMO-1",
        fetchedAt: NOW.toISOString(),
        warnings: [],
        issues: [
          issue("DEMO-1"),
          issue("DEMO-2", { parentId: "DEMO-1", agentPhase: "planning" }),
          issue("DEMO-3", { parentId: "DEMO-1" }),
          issue("DEMO-4", { parentId: "DEMO-1", labels: ["api"] }),
        ],
        comments: [
          normalizeComment(
            {
              id: "claim-2",
              createdAt: NOW.toISOString(),
              user: { name: "Ada Worker" },
              body: `Agent claim — runtime: Conductor · session: ws-1 · profile: backend\nProfile reason: ${reason}`,
            },
            "DEMO-2",
          ),
        ],
      },
      forge: null,
      now: NOW,
    });
    expect(report.inFlight[0]).toMatchObject({ profile: "backend", profileReason: reason });
    expect(report.frontier.find((ticket) => ticket.id === "DEMO-3")?.route).toBeNull();
    expect(report.frontier.find((ticket) => ticket.id === "DEMO-4")?.route?.profile).toBe("backend");
  });

  test("each ready ticket keeps its own labels, without the ready label, for a project's page", () => {
    const config = demoConfig();
    const r = buildStatus({
      config,
      program: {
        rootId: "DEMO-1",
        fetchedAt: NOW.toISOString(),
        issues: [
          issue("DEMO-1"),
          issue("DEMO-2", { parentId: "DEMO-1", labels: [config.tracker.readyLabel, "web", "Bug"] }),
          issue("DEMO-3", { parentId: "DEMO-1" }),
        ],
        comments: [],
        warnings: [],
      },
      forge: null,
      now: NOW,
    });
    expect(r.frontier.map((t) => [t.id, t.labels])).toEqual([
      ["DEMO-2", ["web", "Bug"]],
      ["DEMO-3", []],
    ]);
  });

  test("a parked ticket is listed neither as ready to start nor as unblocked but not marked ready", () => {
    const config = demoConfig();
    const program = {
      rootId: "DEMO-1",
      fetchedAt: NOW.toISOString(),
      comments: [],
      warnings: [],
      issues: [
        issue("DEMO-1"),
        issue("DEMO-2", { parentId: "DEMO-1", labels: [config.tracker.parkedLabel, config.tracker.readyLabel] }),
        issue("DEMO-3", { parentId: "DEMO-1", labels: [config.tracker.parkedLabel] }),
        issue("DEMO-4", { parentId: "DEMO-1" }),
      ],
    };
    const r = buildStatus({ config, program, forge: null, now: NOW });
    // Both status lists are this one frontier, split by `readyForAgent`.
    expect(r.frontier.map((t) => t.id)).toEqual(["DEMO-4"]);
    const parkedElsewhere = buildStatus({
      config: { ...config, tracker: { ...config.tracker, parkedLabel: "on-hold" } },
      program,
      forge: null,
      now: NOW,
    });
    expect(parkedElsewhere.frontier.map((t) => t.id).sort()).toEqual(["DEMO-2", "DEMO-3", "DEMO-4"]);
    // The dashboard keeps whole configs in its snapshots: one written before
    // this field existed still parks, instead of parking nothing.
    const old = { ...config, tracker: { ...config.tracker, parkedLabel: undefined as unknown as string } };
    expect(buildStatus({ config: old, program, forge: null, now: NOW }).frontier.map((t) => t.id)).toEqual(["DEMO-4"]);
  });
  test("lists the last ten tickets merged, newest first, from the reading and Armada's merges since", () => {
    const at = (h: number) => `2026-03-0${h < 24 ? 3 : 4}T${String(h % 24).padStart(2, "0")}:00:00.000Z`;
    const pr = (n: number, state: "merged" | "open" | "closed", mergedAt: string | null = null) => ({
      url: `https://github.com/acme/widgets/pull/${n}`,
      number: n,
      repo: "acme/widgets",
      title: `#${n}`,
      state,
      mergedAt,
    });
    const done = { statusType: "completed" as const, parentId: "DEMO-1" };
    const twelve = Array.from({ length: 12 }, (_, k) =>
      issue(`DEMO-${10 + k}`, { ...done, completedAt: at(k + 1), prs: [pr(10 + k, "merged", at(k))] }),
    );
    const r = buildStatus({
      config: demoConfig(),
      program: {
        rootId: "DEMO-1",
        fetchedAt: at(30),
        warnings: [],
        comments: [],
        issues: [
          issue("DEMO-1"),
          ...twelve,
          // Closed by hand: no merged pull request, so not merged.
          issue("DEMO-2", { ...done, completedAt: at(31), prs: [pr(2, "closed")] }),
          issue("DEMO-3", { ...done, completedAt: at(31) }),
          // Merged but not read with its merge time: when the ticket closed.
          issue("DEMO-4", { ...done, completedAt: at(29), prs: [pr(4, "merged")] }),
          // Merged by Armada after the reading, still In Progress there.
          issue("DEMO-5", { statusType: "started", parentId: "DEMO-1", prs: [pr(5, "open")] }),
          // Canceled after its pull request merged.
          issue("DEMO-6", { statusType: "canceled", parentId: "DEMO-1", prs: [pr(6, "merged", at(32))] }),
        ],
      },
      forge: null,
      live: {
        after: at(30),
        events: { "DEMO-5": { kind: "merge", phase: null, message: null, at: at(33) } },
        handles: {},
      },
      now: NOW,
    });
    expect(r.merged?.map((t) => [t.id, t.mergedAt, t.pr.number])).toEqual([
      ["DEMO-5", at(33), 5],
      ["DEMO-4", at(29), 4],
      ...[21, 20, 19, 18, 17, 16, 15, 14].map((n) => [`DEMO-${n}`, at(n - 10), n]),
    ]);
    expect(r.merged?.[0]).toMatchObject({
      title: "DEMO-5",
      spec: null,
      pr: { url: "https://github.com/acme/widgets/pull/5" },
    });
  });
});

describe("refreshStatusSources", () => {
  test("reads only what it is asked: the pull requests alone keep the program as read, without a Linear call", async () => {
    const config = demoConfig();
    const previous = await readStatusSources(config, {
      linearApiKey: "k",
      githubToken: "g",
      fetch: recordedFetch().fetch,
      now: () => NOW,
    });
    const { fetch, calls } = recordedFetch();
    const next = await refreshStatusSources(
      config,
      previous,
      { linearSince: null, forge: true },
      { linearApiKey: "k", githubToken: "g", fetch, now: () => new Date(NOW.getTime() + 60_000) },
    );
    expect(calls.map((c) => c.operation)).toEqual(["Pulls"]);
    expect(next.program).toBe(previous.program);
    expect(next.forge?.fetchedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());

    const none = await refreshStatusSources(
      config,
      previous,
      { linearSince: null, forge: false },
      {
        linearApiKey: "k",
        githubToken: "g",
        fetch,
      },
    );
    expect(none).toEqual(previous);
    expect(calls).toHaveLength(1);
  });
});

test("default-branch health reaches status JSON and old forge snapshots remain readable", async () => {
  const { fetch } = recordedFetch();
  const sources = await readStatusSources(demoConfig(), {
    linearApiKey: "synthetic-key",
    githubToken: "synthetic-token",
    fetch,
    now: () => NOW,
  });
  const config = parseConfig(`${DEMO_TOML}\n[gates]\nrequired_checks = ["test"]`);
  const forge = sources.forge;
  if (!forge) throw new Error("missing forge fixture");
  expect(buildStatus({ config, ...sources, now: NOW }).main).toBeNull();
  const main = [
    {
      branch: "trunk",
      sha: "a".repeat(40),
      at: NOW.toISOString(),
      headline: "change (#17)",
      ci: "failure" as const,
      checks: [{ name: "test", state: "failure" as const }],
    },
  ];
  expect(
    buildStatus({ config, ...sources, forge: { ...forge, main, mainComplete: true }, now: NOW }).main,
  ).toMatchObject({ branch: "trunk", state: "red", redSince: { pr: 17 } });
});
