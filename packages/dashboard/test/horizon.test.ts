import { describe, expect, test } from "bun:test";
import type { FleetOverview, FleetRow, OwnerValidation, ProjectOverview } from "@armada/core/read";
import { horizonOf } from "../lib/horizon.ts";

// A synthetic fleet: Widgets with a red CI, Gadgets with an owner validation.
const row = (id: string, project: string, over: Partial<FleetRow> = {}): FleetRow =>
  ({
    id,
    title: id,
    url: "",
    project,
    phase: "implementing",
    runtime: "Conductor",
    pr: null,
    silent: false,
    question: null,
    flags: [],
    since: "2026-10-01T11:00:00Z",
    lastUpdate: "2026-10-01T11:55:00Z",
    lastReport: "2026-10-01T11:55:00Z",
    statusLine: null,
    ...over,
  }) as FleetRow;

const project = (slug: string) =>
  ({ slug, name: slug, coordinator: { state: "active", seenAt: null } }) as unknown as ProjectOverview;

const pending = { id: 1, project: "gadgets", ticket: "GAD-2", decision: null } as unknown as OwnerValidation;

const red = { number: 4, url: "", title: "", draft: false, ci: "failure", mergeable: "MERGEABLE", failingChecks: [] };
const green = { ...red, ci: "success" };

const fleet = {
  rows: [
    row("WID-1", "widgets", { phase: "shipping", pr: red as FleetRow["pr"] }),
    row("WID-2", "widgets"),
    row("GAD-1", "gadgets", { silent: true }),
    row("GAD-2", "gadgets", { phase: "ready-to-merge", pr: green as FleetRow["pr"] }),
  ],
  waiting: [],
  projects: [project("widgets"), project("gadgets")],
  validations: [pending],
} satisfies Pick<FleetOverview, "rows" | "waiting" | "projects" | "validations">;

describe("the horizon", () => {
  test("is orange on the fleet's pages while something waits for the owner, red once nothing does but a session fails", () => {
    expect(horizonOf(fleet, { kind: "overview" })).toBe("yours");
    expect(horizonOf(fleet, { kind: "projects" })).toBe("yours");
    expect(horizonOf({ ...fleet, validations: [] }, { kind: "overview" })).toBe("fail");
  });

  test("is lime when everything in flight is ready to merge, blue when the fleet is calm or empty", () => {
    const shipped = { ...fleet, rows: [fleet.rows[3] as FleetRow], validations: [] };
    expect(horizonOf(shipped, { kind: "overview" })).toBe("clear");
    expect(horizonOf({ ...fleet, rows: [fleet.rows[1] as FleetRow], validations: [] }, { kind: "overview" })).toBe(
      "calm",
    );
    expect(horizonOf({ ...fleet, rows: [], validations: [] }, { kind: "overview" })).toBe("calm");
  });

  test("takes an agent's state on its page, and a project's on the project's page", () => {
    expect(horizonOf(fleet, { kind: "agent", ticket: "WID-1" })).toBe("fail");
    expect(horizonOf(fleet, { kind: "agent", ticket: "WID-2" })).toBe("calm");
    expect(horizonOf(fleet, { kind: "agent", ticket: "GAD-1" })).toBe("yours");
    expect(horizonOf(fleet, { kind: "agent", ticket: "GAD-2" })).toBe("clear");
    expect(horizonOf(fleet, { kind: "agent", ticket: "NOPE-1" })).toBe("calm");
    expect(horizonOf(fleet, { kind: "project", slug: "widgets" })).toBe("fail");
    expect(horizonOf(fleet, { kind: "project", slug: "gadgets" })).toBe("yours");
  });

  test("stays calm on Insights and the organization's pages, and turns red when a reading failed", () => {
    expect(horizonOf(fleet, { kind: "insights" })).toBe("calm");
    expect(horizonOf(fleet, { kind: "organization", page: "keys" })).toBe("calm");
    expect(horizonOf(fleet, { kind: "insights" }, true)).toBe("fail");
  });
});
