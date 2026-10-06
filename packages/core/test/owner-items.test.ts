import { describe, expect, test } from "bun:test";
import { coordinatorAlerts, ownerItems, pendingValidations } from "../src/owner-items.ts";
import type { FleetOverview, OwnerValidation, ProjectOverview, WaitingItem } from "../src/read.ts";

// A synthetic fleet, for these tests only.
const project = (slug: string, state: "active" | "idle" | "unknown", seenAt: string | null = null) =>
  ({ slug, name: slug.toUpperCase(), coordinator: { state, seenAt } }) as ProjectOverview;

const workerItem = (kind: WaitingItem["kind"], ticket: string, coordinatorSince: string | null = null): WaitingItem =>
  ({
    kind,
    project: "widgets",
    ticket,
    title: `${kind} on ${ticket}`,
    item: 4,
    since: "2026-03-04T09:00:00Z",
    coordinatorSince,
  }) as WaitingItem;

const validation = (id: number, kind: OwnerValidation["kind"], decided = false): OwnerValidation =>
  ({
    id,
    project: "widgets",
    ticket: "WID-1",
    kind,
    title: "The product card",
    what: "Check it",
    decision: decided ? { outcome: "approved" } : null,
  }) as OwnerValidation;

const overview = (o: Partial<FleetOverview>) =>
  ({
    rows: [],
    waiting: [],
    projects: [project("widgets", "active")],
    validations: [],
    ...o,
  }) as unknown as FleetOverview;

describe("owner items", () => {
  test("fire for a validation to decide, a question escalated to the owner and a stopped coordinator with items waiting", () => {
    expect(pendingValidations({})).toEqual([]);
    expect(
      pendingValidations({
        validations: [validation(3, "merge", true), validation(1, "merge"), validation(2, "question")],
      }).map((v) => v.id),
    ).toEqual([1, 2]);
    const at = (minutes: number) => new Date(Date.parse("2026-03-04T10:00:00Z") + minutes * 60_000).toISOString();
    expect(
      coordinatorAlerts({
        projects: [
          project("widgets", "idle", at(40)),
          project("gadgets", "unknown"),
          project("gizmos", "active", at(1)),
        ],
        waiting: [
          workerItem("question", "WID-1", at(25)),
          workerItem("question", "WID-2", at(35)),
          workerItem("question", "WID-3"),
          { ...workerItem("question", "GAD-1"), project: "gadgets" },
          { ...workerItem("question", "GIZ-1", at(50)), project: "gizmos" },
        ],
      }),
    ).toEqual([{ project: "widgets", state: "idle", seenAt: at(40), waiting: 2, since: at(25) }]);
    const items = ownerItems(
      overview({
        validations: [validation(7, "merge"), validation(8, "question"), validation(9, "validation", true)],
        projects: [project("widgets", "idle", "2026-03-04T08:00:00Z")],
        waiting: [workerItem("question", "WID-2", "2026-03-04T09:00:00Z")],
      }),
    );
    expect(items.map((i) => [i.kind, i.href])).toEqual([
      ["validation", "/approve/7"],
      ["question", "/approve/8"],
      ["coordinator", "/projects/widgets"],
    ]);
    expect(items.map((i) => i.key)).toEqual([
      "validation:widgets:7",
      "validation:widgets:8",
      "coordinator:widgets:2026-03-04T08:00:00Z",
    ]);
    const bounced = ownerItems(
      overview({
        projects: [project("widgets", "idle", "2026-03-04T10:00:00Z")],
        waiting: [workerItem("question", "WID-2", "2026-03-04T11:00:00Z")],
      }),
    );
    expect(bounced[0]?.key).toBe("coordinator:widgets:2026-03-04T10:00:00Z");
    expect(
      ownerItems(
        overview({
          waiting: [workerItem("question", "WID-2"), workerItem("approval", "WID-3"), workerItem("hand-back", "WID-4")],
        }),
      ),
    ).toEqual([]);
    expect(ownerItems(overview({ waiting: [workerItem("question", "WID-2", "2026-03-04T09:00:00Z")] }))).toEqual([]);
  });
});
