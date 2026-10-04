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
import {
  coordinatorHarness,
  coordinatorLink,
  launchProfileLabel,
  progressPercent,
  prState,
} from "../lib/project-view.ts";

const NOW = new Date("2026-10-01T13:42:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

test("ready labels show the routed profile or defer to the coordinator in the viewer's language", () => {
  const ticket = { route: { profile: "backend", why: 'rule 1 (label "api")' } };
  expect(launchProfileLabel(ticket, "chosen by the coordinator")).toBe("backend");
  expect(launchProfileLabel({ route: null }, "chosen by the coordinator")).toBe("chosen by the coordinator");
  expect(launchProfileLabel({ route: null }, "choisi par le coordinateur")).toBe("choisi par le coordinateur");
});

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

describe("a project's page", () => {
  test("reads each demo project as the design draws it: progress, owner, open PRs and coordinator", () => {
    const o = demoOverview();
    const lines = o.projects.map((p) => ({
      name: p.name,
      percent: progressPercent(p.progress),
      owner: p.owner,
      health: p.health,
      prs: p.pullRequests?.map((pr) => prState(pr)),
      harness: coordinatorHarness(p.coordinator.harness),
      coordinator: p.coordinator.state,
    }));
    expect(lines).toEqual([
      {
        name: "Widgets",
        percent: 58,
        owner: "Léa Martin",
        health: "blocked",
        prs: ["red", "green"],
        harness: "conductor",
        coordinator: "active",
      },
      {
        name: "Gadgets",
        percent: 55,
        owner: "Hugo Bernard",
        health: "blocked",
        prs: ["conflict"],
        harness: "claude-code",
        coordinator: "idle",
      },
      {
        name: "Armada",
        percent: 89,
        owner: "Camille Roux",
        health: "on-track",
        prs: ["green"],
        harness: "codex",
        coordinator: "active",
      },
    ]);
  });

  test("progress is unknown without a reading, and zero out of zero is 0 %", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
    expect(progressPercent({ done: 1, total: 3 })).toBe(33);
  });
});

describe("a project's pull requests and coordinator", () => {
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
