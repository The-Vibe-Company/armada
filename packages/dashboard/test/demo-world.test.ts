import { describe, expect, test } from "bun:test";
import { buildOverview, buildStatus, configTemplate, type InboxItem, parseConfig } from "@armada/core/read";
import {
  DEMO_COORDINATOR_SEEN,
  DEMO_INBOX,
  DEMO_PROJECTS,
  demoHistory,
  demoSnapshot,
  HISTORY_DAYS,
} from "../lib/demo/world.ts";
import { AGENT_STATUSES, agentState, harnessOf, projectColor } from "../lib/fleet-view.ts";

const NOW = new Date("2026-10-01T13:42:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** The demo fleet as the dashboard shows it, with the seeded inbox and coordinator reads. */
function demoOverview(scenario: "fleet" | "large" = "fleet") {
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
      const { program, forge } = demoSnapshot(p, scenario, NOW);
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
    const harnesses = o.rows.map((r) => harnessOf(r.runtime));
    expect([
      harnesses.filter((h) => h === "conductor").length,
      harnesses.filter((h) => h === "claude-code").length,
    ]).toEqual([6, 3]);
    expect(harnesses.filter((h) => h === "codex")).toHaveLength(2);
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

  test("the large world has lists of hundreds of rows, and one ticket with hours of reports", () => {
    const o = demoOverview("large");
    expect(o.rows.length).toBeGreaterThan(250);
    const first = DEMO_PROJECTS.flatMap((p) => demoSnapshot(p, "large", NOW).program.comments).filter(
      (c) => c.issueId === "WID-400",
    );
    expect(first.length).toBeGreaterThan(300);
  });
});

describe("the demo's two weeks of history (THE-893)", () => {
  const history = demoHistory();
  const mergedAgo = (h: (typeof history)[number]) => h.claimed - (h.steps.at(-1)?.at ?? 0);
  const DAY = 24 * 60;

  test("ships each project's done tickets, the same ones its snapshot lists, the same every seed", () => {
    expect(demoHistory()).toEqual(history);
    for (const p of DEMO_PROJECTS) {
      const done = demoSnapshot(p, "fleet", NOW).program.issues.filter((i) => i.statusType === "completed");
      expect(history.filter((h) => h.project === p.slug).map((h) => h.ticket)).toEqual(done.map((i) => i.id));
    }
    for (const h of history) expect(h.steps.at(-1)?.kind).toBe("merge");
  });

  test("covers two weeks, more merged in the second, with re-plans, new heads, questions, validations and silences", () => {
    const days = history.map((h) => Math.floor(mergedAgo(h) / DAY));
    expect(Math.max(...days)).toBe(HISTORY_DAYS - 1);
    expect(days.filter((d) => d < 7).length).toBeGreaterThan(days.filter((d) => d >= 7).length);
    const steps = history.flatMap((h) => h.steps);
    const handedBack = history.filter(
      (h) => new Set(h.steps.flatMap((s) => (s.kind === "report" && s.headSha ? [s.headSha] : []))).size > 1,
    );
    expect(handedBack.length).toBeGreaterThan(0);
    for (const kind of ["plan", "question", "hand-back", "validation"] as const)
      expect(steps.some((s) => s.kind === kind)).toBe(true);
    expect(history.some((h) => h.quiet)).toBe(true);
  });
});
