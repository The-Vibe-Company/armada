import { describe, expect, test } from "bun:test";
import type { FleetOverview, FleetRow, OwnerValidation, ProjectOverview, WaitingItem } from "@armada/core/read";
import { changes, sentence, watched } from "../lib/announce.ts";
import { STRINGS } from "../lib/i18n.ts";

// A synthetic fleet, two polls apart.
const row = (id: string, phase: FleetRow["phase"]): FleetRow =>
  ({ id, title: `Title of ${id}`, project: "widgets", phase, runtime: "Conductor" }) as FleetRow;

const question = (ticket: string, item: number): WaitingItem =>
  ({ kind: "question", project: "widgets", ticket, title: `Question on ${ticket}`, item }) as WaitingItem;

const validation = (id: number, title: string): OwnerValidation =>
  ({ id, project: "widgets", ticket: "WID-1", title, what: "Check it", decision: null }) as OwnerValidation;

const project = { slug: "widgets", name: "Widgets", coordinator: { state: "active" } } as ProjectOverview;

const overview = (o: Partial<FleetOverview>) =>
  ({ rows: [], waiting: [], projects: [project], validations: [], ...o }) as unknown as FleetOverview;

const en = STRINGS.en;
const say = (a: Partial<FleetOverview>, b: Partial<FleetOverview>) =>
  sentence(en, changes(watched(overview(a)), watched(overview(b))));

describe("the live region", () => {
  test("says nothing when nothing that matters changed", () => {
    const same = { rows: [row("WID-1", "implementing")], waiting: [question("WID-1", 4)] };
    expect(say(same, same)).toBeNull();
    // An agent that starts or ends, or an item answered, is not news.
    expect(say({ rows: [row("WID-1", "implementing")] }, { rows: [row("WID-2", "planning")] })).toBeNull();
    expect(say({ waiting: [question("WID-1", 4)] }, {})).toBeNull();
  });

  test("names a new item waiting for the viewer", () => {
    expect(say({}, { validations: [validation(7, "Design the product card")] })).toBe(
      "Waiting for you: Design the product card",
    );
    expect(say({}, { waiting: [question("WID-1", 4)] })).toBe("Waiting for you: Question on WID-1");
  });

  test("names an agent's phase change", () => {
    expect(say({ rows: [row("WID-1", "implementing")] }, { rows: [row("WID-1", "shipping")] })).toBe(
      "WID-1 is now Shipping",
    );
  });

  test("collapses a burst into counts, one sentence per kind", () => {
    const before = { rows: [row("WID-1", "planning"), row("WID-2", "implementing")] };
    const after = {
      rows: [row("WID-1", "implementing"), row("WID-2", "shipping")],
      waiting: [question("WID-1", 4), question("WID-2", 5)],
    };
    expect(say(before, after)).toBe("2 new items waiting for you. 2 agents changed phase");
  });

  test("speaks the viewer's language", () => {
    const list = changes(
      watched(overview({ rows: [row("WID-1", "implementing")] })),
      watched(overview({ rows: [row("WID-1", "blocked")] })),
    );
    expect(sentence(STRINGS.fr, list)).toBe("WID-1 passe en Bloqué");
  });
});
