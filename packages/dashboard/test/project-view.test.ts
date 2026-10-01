import { describe, expect, test } from "bun:test";
import { buildOverview, buildStatus, configTemplate, type InboxItem, parseConfig } from "@armada/core/read";
import {
  DEMO_INBOX,
  DEMO_PROJECT_FACTS,
  DEMO_PROJECTS,
  demoCoordinatorFacts,
  demoInboxReads,
  demoSnapshot,
} from "../lib/demo/world.ts";
import { paths } from "../lib/fleet-view.ts";
import {
  coordinatorHarness,
  coordinatorLink,
  lastActivity,
  prCounts,
  progressPercent,
  projectBlockers,
  projectSlice,
  prState,
} from "../lib/project-view.ts";

const NOW = new Date("2026-10-01T13:42:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** The demo fleet as `demo:seed` leaves it: owners, inbox, and each coordinator's reads and facts. */
function demoOverview() {
  const inbox: InboxItem[] = DEMO_INBOX.map((i, k) => ({
    id: k + 1,
    project: i.project,
    ticket: i.ticket,
    kind: i.kind,
    recipient: "coordinator",
    author: i.author,
    body: i.body,
    createdAt: ago(i.ago),
  }));
  return buildOverview({
    projects: DEMO_PROJECTS.map((p) => {
      const config = parseConfig(configTemplate(p));
      const { program, forge } = demoSnapshot(p, "fleet", NOW);
      const reads = demoInboxReads(p.slug);
      const facts = demoCoordinatorFacts(p.slug);
      const seen = ago(reads[0] ?? 0);
      return {
        owner: DEMO_PROJECT_FACTS[p.slug]?.owner ?? null,
        slug: p.slug,
        name: p.name,
        repository: p.repository,
        report: buildStatus({ config, program, forge, now: NOW }),
        error: null,
        live: {
          inbox: inbox.filter((i) => i.project === p.slug),
          coordinatorSeenAt: seen,
          coordinator: facts && {
            ...facts,
            startedAt: ago(reads.at(-1) ?? 0),
            seenAt: seen,
            inboxSeenAt: seen,
          },
        },
      };
    }),
    live: { state: "ok", error: null },
    now: NOW,
  });
}

describe("the Projects list", () => {
  test("reads each demo project as the mockup draws it: progress, owner, health, PRs and coordinator", () => {
    const o = demoOverview();
    const lines = o.projects.map((p) => ({
      name: p.name,
      percent: progressPercent(p.progress),
      owner: p.owner,
      health: p.health,
      prs: prCounts(p.pullRequests),
      harness: coordinatorHarness(p.coordinator.harness),
      coordinator: p.coordinator.state,
    }));
    expect(lines).toEqual([
      {
        name: "Widgets",
        percent: 58,
        owner: "Léa Martin",
        health: "blocked",
        prs: { open: 2, green: 1 },
        harness: "conductor",
        coordinator: "active",
      },
      {
        name: "Gadgets",
        percent: 60,
        owner: "Hugo Bernard",
        health: "blocked",
        prs: { open: 1, green: 0 },
        harness: "claude-code",
        coordinator: "idle",
      },
      {
        name: "Armada",
        percent: 89,
        owner: "Camille Roux",
        health: "on-track",
        prs: { open: 1, green: 1 },
        harness: "codex",
        coordinator: "active",
      },
    ]);
  });

  test("a project's last activity is its newest report or coordinator command", () => {
    const project = { coordinator: { seenAt: ago(30) } };
    expect(lastActivity(project, [{ lastReport: ago(40), lastUpdate: ago(5) }])).toBe(ago(5));
    expect(lastActivity(project, [])).toBe(ago(30));
    expect(lastActivity({ coordinator: { seenAt: null } }, [{ lastReport: null, lastUpdate: ago(9) }])).toBe(ago(9));
    expect(lastActivity({ coordinator: { seenAt: null } }, [])).toBeNull();
  });

  test("progress is unknown without a reading, and zero out of zero is 0 %", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
    expect(progressPercent({ done: 1, total: 3 })).toBe(33);
  });
});

describe("a project's page", () => {
  test("lists what blocks Widgets, failures first, each opening its agent", () => {
    const o = demoOverview();
    const widgets = o.projects.find((p) => p.slug === "widgets");
    if (!widgets) throw new Error("no Widgets");
    const slice = projectSlice(o, "widgets");
    const blockers = projectBlockers(widgets, slice.rows, slice.waiting, paths.agent);
    expect(blockers.map((b) => [b.tone, b.reason, b.ticket, b.href])).toEqual([
      ["error", "ci", "WID-14", "/agents/WID-14"],
      ["waiting", "question", "WID-15", "/agents/WID-15"],
      ["silent", "silent", "WID-17", "/agents/WID-17"],
    ]);
    expect(blockers[1]?.text).toBe("How long should a sign-in link stay valid?");
  });

  test("nothing blocks Armada", () => {
    const o = demoOverview();
    const armada = o.projects.find((p) => p.slug === "armada");
    if (!armada) throw new Error("no Armada");
    const slice = projectSlice(o, "armada");
    expect(projectBlockers(armada, slice.rows, slice.waiting, paths.agent)).toEqual([]);
  });

  test("a red pull request no agent holds, a launch never started and an away coordinator block too", () => {
    const pr = {
      number: 35,
      url: "https://github.com/acme/widgets/pull/35",
      title: "chore: bump dependencies",
      draft: false,
      ci: "failure" as const,
      mergeable: "MERGEABLE",
      headSha: null,
      updatedAt: null,
      failingChecks: ["test"],
      branch: "chore/bump",
      ticket: null,
    };
    const waiting = {
      project: "widgets",
      ticket: "WID-30",
      title: "Archive invoices",
      url: null,
      detail: "launched 40 min ago, never claimed",
      author: null,
      item: null,
      answer: null,
    };
    const blockers = projectBlockers(
      { slug: "widgets", pullRequests: [pr], coordinator: { state: "idle" } },
      [],
      [
        { ...waiting, kind: "not-started", since: ago(40), coordinatorSince: null },
        { ...waiting, kind: "question", ticket: "WID-31", since: ago(50), coordinatorSince: ago(50) },
      ],
      paths.agent,
    );
    expect(blockers.map((b) => [b.tone, b.reason, b.ticket ?? b.pr, b.since])).toEqual([
      ["error", "ci", 35, null],
      ["waiting", "coordinator", null, ago(50)],
      ["silent", "not-started", "WID-30", ago(40)],
    ]);
  });

  test("a pull request reads green, red, conflict, pending or none; a conflict wins over its checks", () => {
    expect(prState({ ci: "success", mergeable: "MERGEABLE" })).toBe("green");
    expect(prState({ ci: "failure", mergeable: "MERGEABLE" })).toBe("red");
    expect(prState({ ci: "success", mergeable: "CONFLICTING" })).toBe("conflict");
    expect(prState({ ci: "pending", mergeable: null, mergeability: "conflicting" })).toBe("conflict");
    expect(prState({ ci: "pending", mergeable: null })).toBe("pending");
    expect(prState({ ci: null, mergeable: null })).toBe("none");
  });

  test("only a Conductor Cloud coordinator has a session link: its workspace", () => {
    expect(coordinatorLink({ harness: "conductor-cloud", handle: "ws-0c01/coord" })).toBe(
      "conductor://workspace?id=ws-0c01",
    );
    expect(coordinatorLink({ harness: "claude-code", handle: "local · tty s004" })).toBeNull();
    expect(coordinatorLink({ harness: "conductor-cloud", handle: null })).toBeNull();
    expect(coordinatorLink({})).toBeNull();
  });
});
