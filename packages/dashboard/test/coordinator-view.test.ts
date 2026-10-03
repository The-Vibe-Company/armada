import { describe, expect, test } from "bun:test";
import type { FleetRow, OwnerValidation, ProjectOverview } from "@armada/core/read";
import {
  BOARD_COLUMNS,
  cardBadges,
  checksOf,
  coordinatorGroups,
  laneColumns,
  overviewLine,
  ownerChecks,
  projectChecks,
} from "../lib/coordinator-view.ts";
import { demoOverview } from "../lib/demo/overview.ts";

// The overview by coordinator (THE-916): synthetic fleet, invented tickets and people.

const at = (m: number) => new Date(Date.UTC(2026, 9, 2, 12, m)).toISOString();
const row = (id: string, over: Partial<FleetRow> = {}) =>
  ({
    id,
    title: `Ticket ${id}`,
    project: "widgets",
    phase: "implementing",
    pr: null,
    silent: false,
    question: null,
    flags: [],
    ...over,
  }) as FleetRow;
const project = (slug: string) => ({ slug, name: slug }) as ProjectOverview;
const validation = (id: number, ticket: string, over: Partial<OwnerValidation> = {}) =>
  ({
    id,
    project: "widgets",
    ticket,
    kind: "validation",
    createdAt: at(id),
    decision: null,
    ...over,
  }) as OwnerValidation;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("À valider", () => {
  test("is an open owner validation of any kind on that session; a decided one, another ticket's or project's is not", () => {
    const validations = [
      validation(1, "WID-1", { kind: "merge" }),
      validation(2, "WID-2", { kind: "question" }),
      validation(3, "WID-3", {
        decision: { outcome: "approved", by: "Ada", at: at(9) } as OwnerValidation["decision"],
      }),
      validation(4, "WID-1", { project: "gadgets" }),
      validation(5, "WID-1"),
    ];
    const checks = ownerChecks({ validations });
    expect(checksOf(checks, row("WID-1")).map((v) => v.id)).toEqual([1, 5]);
    expect(checksOf(checks, row("WID-2")).map((v) => v.kind)).toEqual(["question"]);
    expect(checksOf(checks, row("WID-3"))).toEqual([]);
    expect(checksOf(checks, row("WID-1", { project: "gadgets" })).map((v) => v.id)).toEqual([4]);
    expect(projectChecks({ validations }, "widgets")).toBe(3);
    // An overview from before validations has none.
    expect(checksOf(ownerChecks({}), row("WID-1"))).toEqual([]);
  });

  test("a worker's question or plan waiting for the coordinator is not the owner's", () => {
    const checks = ownerChecks({ validations: [] });
    expect(checksOf(checks, row("WID-1", { phase: "awaiting-approval" }))).toEqual([]);
  });
});

describe("the overview's groups", () => {
  const projects = [project("widgets"), project("gadgets"), project("armada")];
  const rows = [
    row("WID-1"),
    row("WID-2", { pr: { ci: "failure" } as FleetRow["pr"] }),
    row("WID-3"),
    row("GAD-1", { project: "gadgets" }),
    row("GAD-2", { project: "gadgets" }),
  ];

  test("one per coordinator: what the owner validates first, then the most urgent, then the list's order", () => {
    const groups = coordinatorGroups({ projects, validations: [validation(1, "WID-3")] }, rows);
    expect(groups.map((g) => [g.project.slug, ids(g.rows), g.toValidate])).toEqual([
      ["widgets", ["WID-3", "WID-2", "WID-1"], 1],
      ["gadgets", ["GAD-1", "GAD-2"], 0],
      ["armada", [], 0],
    ]);
  });

  test("the groups with something to validate come first; a sort the viewer chose stays after it", () => {
    const groups = coordinatorGroups(
      { projects, validations: [validation(1, "GAD-2", { project: "gadgets" })] },
      rows,
      { sorted: true, empty: false },
    );
    expect(groups.map((g) => [g.project.slug, ids(g.rows)])).toEqual([
      ["gadgets", ["GAD-2", "GAD-1"]],
      ["widgets", ["WID-1", "WID-2", "WID-3"]],
    ]);
  });

  test("the line counts coordinators, sessions in flight and what the owner has to validate", () => {
    expect(overviewLine({ projects, rows, validations: [validation(1, "WID-1"), validation(2, "WID-2")] })).toEqual({
      coordinators: 3,
      running: 5,
      toValidate: 2,
    });
  });
});

describe("the board (THE-968, THE-988)", () => {
  const none = ownerChecks({ validations: [] });

  test("puts each session in the column of its step, keeping the lane's order", () => {
    const rows = [
      row("WID-1", { phase: "implementing", step: "implementing" }),
      row("WID-2", { phase: "planning", step: "plan" }),
      row("WID-3", { phase: "blocked", step: "implementing" }),
      row("WID-4", { phase: "ready-to-merge", step: "ci" }),
    ];
    const columns = laneColumns(rows);
    expect(Object.keys(columns)).toEqual(["plan", "implementing", "review", "ci", "merged"]);
    expect(ids(columns.implementing)).toEqual(["WID-1", "WID-3"]);
    expect(ids(columns.plan)).toEqual(["WID-2"]);
    expect(ids(columns.ci)).toEqual(["WID-4"]);
    expect(columns.review).toEqual([]);
  });

  test("badges say what columns no longer do, most urgent first", () => {
    const checks = ownerChecks({ validations: [validation(1, "WID-1", { kind: "question" })] });
    const badges = (id: string, over: Partial<FleetRow>) => cardBadges(checks, row(id, over));
    expect(badges("WID-1", { phase: "blocked", silent: true })).toEqual(["validate", "blocked", "silent"]);
    expect(badges("WID-2", { phase: "implementing", silent: true })).toEqual(["silent"]);
    expect(badges("WID-2", { phase: "awaiting-approval" })).toEqual(["approval"]);
    expect(badges("WID-2", { phase: "ready-to-merge" })).toEqual(["ready"]);
    expect(badges("WID-2", { phase: "implementing" })).toEqual([]);
    expect(cardBadges(none, row("WID-1", { phase: "awaiting-validation" }))).toEqual([]);
  });

  test("on the demo world, every session sits in its step's column, and the lane counts are the open validations", () => {
    const o = demoOverview(new Date("2026-10-01T13:42:00Z"));
    const checks = ownerChecks(o);
    const groups = coordinatorGroups(o, o.rows);
    const placed = groups.flatMap((g) => Object.values(laneColumns(g.rows)).flat());
    expect(ids(placed).sort()).toEqual(ids(o.rows).sort());
    const step = (id: string) => o.rows.find((r) => r.id === id)?.step;
    expect([step("GAD-6"), step("GAD-3"), step("WID-12"), step("WID-15"), step("GAD-5"), step("WID-14")]).toEqual([
      "plan",
      "plan",
      "implementing",
      // Blocked and awaiting a design's validation: in the step they left.
      "implementing",
      "review",
      "ci",
    ]);
    expect([step("WID-18"), step("GAD-9")]).toEqual(["ci", "implementing"]);
    for (const g of groups) {
      const mine = g.rows.filter((r) => checksOf(checks, r).length);
      expect(mine.every((r) => cardBadges(checks, r)[0] === "validate")).toBe(true);
      expect(g.toValidate).toBe(mine.reduce((n, r) => n + checksOf(checks, r).length, 0));
      // The Merged column: the coordinator's last ten merged tickets, newest first.
      const merged = g.project.merged;
      expect(merged.length).toBe(Math.min(10, g.project.progress?.done ?? 0));
      expect(merged.map((m) => m.mergedAt)).toEqual(
        merged
          .map((m) => m.mergedAt)
          .sort()
          .reverse(),
      );
    }
    const used = BOARD_COLUMNS.filter((c) => groups.some((g) => laneColumns(g.rows)[c].length));
    expect(used).toEqual(["plan", "implementing", "review", "ci"]);
  });
});
