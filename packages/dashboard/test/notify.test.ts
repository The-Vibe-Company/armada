import { describe, expect, test } from "bun:test";
import type { FleetOverview, OwnerValidation, ProjectOverview } from "@armada/core/read";
import { STRINGS } from "../lib/i18n.ts";
import { inQuietHours, notificationTitle, ownerItems, toNotify } from "../lib/notify.ts";

// A synthetic fleet, for these tests only.
const project = (slug: string, state: "active" | "idle", seenAt: string | null = null) =>
  ({ slug, name: slug.toUpperCase(), coordinator: { state, seenAt } }) as ProjectOverview;

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
  test("fire once per item, and only when turned on", () => {
    const items = ownerItems(overview({ validations: [validation(7, "merge"), validation(8, "validation")] }));
    const first = items[0];
    if (!first) throw new Error("owner item missing");
    expect(notificationTitle(STRINGS.en, first)).toBe("To decide: WID-1 · The product card");
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
