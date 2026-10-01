import { describe, expect, test } from "bun:test";
import { buildOverview, buildStatus, configTemplate, type InboxItem, parseConfig } from "@armada/core/read";
import { DEMO_COORDINATOR_SEEN, DEMO_INBOX, DEMO_PROJECTS, demoSnapshot } from "../lib/demo/world.ts";
import { AGENT_STATUSES, agentState, harnessCounts, projectColor } from "../lib/fleet-view.ts";

const NOW = new Date("2026-10-01T13:42:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** The demo fleet as the dashboard shows it, with the seeded inbox and coordinator reads. */
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
      const seen = DEMO_COORDINATOR_SEEN[p.slug];
      return {
        slug: p.slug,
        name: p.name,
        repository: p.repository,
        report: buildStatus({ config, program, forge, now: NOW }),
        error: null,
        live: {
          inbox: inbox.filter((i) => i.project === p.slug),
          coordinatorSeenAt: seen === undefined ? null : ago(seen),
        },
      };
    }),
    live: { state: "ok", error: null },
    now: NOW,
  });
}

describe("the demo world", () => {
  test("is the mockup's Acme world: three projects and eleven sessions in every state", () => {
    const o = demoOverview();
    expect(o.projects.map((p) => p.name)).toEqual(["Widgets", "Gadgets", "Armada"]);
    expect(o.rows).toHaveLength(11);
    const byTicket = Object.fromEntries(o.rows.map((r) => [r.id, agentState(r)]));
    expect(byTicket).toMatchObject({
      "WID-15": { status: "waiting", reason: "question" },
      "GAD-3": { status: "waiting", reason: "approval" },
      "GAD-9": { status: "waiting", reason: "validation" },
      "WID-14": { status: "error", reason: "ci" },
      "GAD-5": { status: "error", reason: "conflict" },
      "WID-17": { status: "silent" },
      "WID-12": { status: "running" },
      "WID-18": { status: "done" },
      "THE-858": { status: "done" },
    });
    expect(new Set(Object.values(byTicket).map((s) => s.status))).toEqual(new Set(AGENT_STATUSES));
    expect(harnessCounts(o.rows)).toEqual({ conductor: 6, "claude-code": 3, codex: 2, other: 0 });
  });

  test("waits on a question, a plan and two hand-backs, and has one idle coordinator", () => {
    const o = demoOverview();
    expect(o.waiting.filter((w) => w.kind !== "silent").map((w) => `${w.kind} ${w.ticket}`)).toEqual([
      "question WID-15",
      "approval GAD-3",
      "hand-back THE-858",
      "hand-back WID-18",
    ]);
    expect(o.projects.map((p) => p.coordinator.state)).toEqual(["active", "idle", "active"]);
    expect(o.ready.map((r) => r.id)).toContain("THE-866");
  });

  test("keeps the mockup's project colors", () => {
    expect(["widgets", "gadgets", "armada"].map(projectColor)).toEqual(["#7ea6ff", "#ffb547", "#b6f15a"]);
  });
});
