import { describe, expect, test } from "bun:test";
import { type FleetRow, type OwnerValidation, type ProjectOverview, pipeline } from "@armada/core/read";
import {
  BOARD_COLUMNS,
  boardColumn,
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
/** A row whose pipeline step is core's, as the overview builds it. */
const flight = (id: string, over: Partial<FleetRow> = {}) => {
  const r = row(id, over);
  return { ...r, pipeline: pipeline(r) };
};
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

describe("the board (THE-968)", () => {
  const none = ownerChecks({ validations: [] });
  const pr = (ci: "success" | "failure" | "pending" | "none") => ({ ci }) as FleetRow["pr"];

  test("puts each session in the column of its phase", () => {
    const column = (over: Partial<FleetRow>) => boardColumn(none, flight("WID-1", over));
    expect(column({ phase: "planning" })).toBe("plan");
    expect(column({ phase: "awaiting-approval" })).toBe("approval");
    expect(column({ phase: "implementing" })).toBe("implementing");
    expect(column({ phase: "shipping", pr: pr("none") })).toBe("delivery");
    expect(column({ phase: "shipping", pr: pr("pending") })).toBe("delivery");
    // Red CI is still delivery's to fix, in its red tone.
    expect(column({ phase: "shipping", pr: pr("failure") })).toBe("delivery");
    expect(column({ phase: "awaiting-validation" })).toBe("validate");
    expect(column({ phase: "ready-to-merge", pr: pr("success") })).toBe("validate");
    expect(column({ phase: "blocked" })).toBe("blocked");
    expect(column({ phase: "implementing", silent: true })).toBe("blocked");
  });

  test("an open owner validation wins over a blocked or silent session", () => {
    const checks = ownerChecks({ validations: [validation(1, "WID-1", { kind: "question" })] });
    expect(boardColumn(checks, flight("WID-1", { phase: "blocked", silent: true }))).toBe("validate");
    expect(boardColumn(checks, flight("WID-2", { phase: "blocked" }))).toBe("blocked");
  });

  test("keeps the lane's order in each column", () => {
    const rows = [
      flight("WID-1", { phase: "implementing" }),
      flight("WID-2", { phase: "planning" }),
      flight("WID-3", { phase: "implementing" }),
    ];
    const columns = laneColumns(none, rows);
    expect(Object.keys(columns)).toEqual([...BOARD_COLUMNS]);
    expect(ids(columns.implementing)).toEqual(["WID-1", "WID-3"]);
    expect(ids(columns.plan)).toEqual(["WID-2"]);
    expect(columns.blocked).toEqual([]);
  });

  test("on the demo world, every session in flight sits in one column, and what the owner validates in theirs", () => {
    const o = demoOverview(new Date("2026-10-01T13:42:00Z"));
    const checks = ownerChecks(o);
    const groups = coordinatorGroups(o, o.rows);
    const placed = groups.flatMap((g) => Object.values(laneColumns(checks, g.rows)).flat());
    expect(ids(placed).sort()).toEqual(ids(o.rows).sort());
    for (const g of groups) {
      const columns = laneColumns(checks, g.rows);
      const mine = g.rows.filter((r) => checksOf(checks, r).length);
      expect(mine.every((r) => columns.validate.includes(r))).toBe(true);
      expect(g.toValidate).toBe(mine.reduce((n, r) => n + checksOf(checks, r).length, 0));
    }
    // Every column but one holds a session somewhere in the demo.
    const used = BOARD_COLUMNS.filter((c) => groups.some((g) => laneColumns(checks, g.rows)[c].length));
    expect(used.length).toBeGreaterThanOrEqual(5);
  });
});
