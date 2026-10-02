import { describe, expect, test } from "bun:test";
import type { FleetRow, OwnerValidation, ProjectOverview } from "@armada/core/read";
import { checksOf, coordinatorGroups, overviewLine, ownerChecks, projectChecks } from "../lib/coordinator-view.ts";

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
