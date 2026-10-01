import { describe, expect, test } from "bun:test";
import type { FleetOverview, OwnerValidation, ProjectOverview, WaitingItem } from "@armada/core/read";
import { STRINGS } from "../lib/i18n.ts";
import { inQuietHours, notificationTitle, ownerItems, toNotify } from "../lib/notify.ts";

// A synthetic fleet, for these tests only.
const project = (slug: string, state: "active" | "idle", seenAt: string | null = null) =>
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

const ON = { on: true, quiet: null };
const NOON = new Date(2026, 2, 4, 12, 0);

describe("owner notifications", () => {
  test("fire for a validation to decide, a question escalated to the owner and a stopped coordinator with items waiting", () => {
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
    expect(items.map((i) => notificationTitle(STRINGS.en, i))).toEqual([
      "To decide: WID-1 · The product card",
      "Question for you: WID-1 · The product card",
      "WIDGETS: the coordinator stopped, 1 item waits",
    ]);
  });

  test("never fire for what the coordinator handles: a worker's question, plan or hand-back, or an agent's phase", () => {
    const items = ownerItems(
      overview({
        waiting: [workerItem("question", "WID-2"), workerItem("approval", "WID-3"), workerItem("hand-back", "WID-4")],
        rows: [{ id: "WID-5", phase: "blocked" }] as FleetOverview["rows"],
      }),
    );
    expect(items).toEqual([]);
    // An active coordinator with items waiting is doing its job.
    expect(ownerItems(overview({ waiting: [workerItem("question", "WID-2", "2026-03-04T09:00:00Z")] }))).toEqual([]);
  });

  test("fire once per item, and only when turned on", () => {
    const items = ownerItems(overview({ validations: [validation(7, "merge"), validation(8, "validation")] }));
    expect(toNotify(items, new Set(), ON, NOON).map((i) => i.key)).toEqual([
      "validation:widgets:7",
      "validation:widgets:8",
    ]);
    expect(toNotify(items, new Set(["validation:widgets:7"]), ON, NOON).map((i) => i.key)).toEqual([
      "validation:widgets:8",
    ]);
    expect(toNotify(items, new Set(), { on: false, quiet: null }, NOON)).toEqual([]);
  });

  test("stay quiet in the quiet hours, over midnight too", () => {
    const night = { from: "22:00", to: "07:30" };
    const day = { from: "12:00", to: "14:00" };
    const at = (h: number, m = 0) => new Date(2026, 2, 4, h, m);
    expect([at(21, 59), at(22), at(3), at(7, 29), at(7, 30)].map((d) => inQuietHours(night, d))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect([at(11, 59), at(12), at(13, 59), at(14)].map((d) => inQuietHours(day, d))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const items = ownerItems(overview({ validations: [validation(7, "merge")] }));
    expect(toNotify(items, new Set(), { on: true, quiet: day }, NOON)).toEqual([]);
  });
});
