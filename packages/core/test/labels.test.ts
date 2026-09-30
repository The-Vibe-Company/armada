import { describe, expect, test } from "bun:test";
import { checkLabels, createMissingLabels, readLabels } from "../src/labels.ts";
import { DEMO_TEAM, demoConfig, type FakeLabel, fakeLinearLabels } from "./support.ts";

const group = (id: string, name: string, teamId: string | null): FakeLabel => ({
  id,
  name,
  isGroup: true,
  teamId,
  parentId: null,
});
const value = (id: string, name: string, parentId: string, teamId: string | null): FakeLabel => ({
  id,
  name,
  isGroup: false,
  teamId,
  parentId,
});

describe("tracker labels", () => {
  test("the program's team group wins over a shared one, another team's is ignored, and gaps are named", async () => {
    const linear = fakeLinearLabels([
      group("g-other", "Agent phase", "team-other"),
      group("g-shared", "Agent phase", null),
      value("v1", "planning", "g-shared", null),
      group("g-team", "agent phase", DEMO_TEAM.id),
      value("v2", "Planning", "g-team", DEMO_TEAM.id),
      value("v3", "implementing", "g-team", DEMO_TEAM.id),
    ]);
    const state = await readLabels(demoConfig(), { apiKey: "k", fetch: linear.fetch });
    expect(state.groups).toEqual([
      {
        name: "Agent phase",
        id: "g-team",
        scope: "team",
        missing: ["awaiting-approval", "shipping", "blocked", "ready-to-merge"],
      },
      { name: "Agent runtime", id: null, scope: null, missing: ["Claude Code", "Codex", "Conductor"] },
    ]);
    expect(checkLabels(state).map((c) => [c.level, c.message])).toEqual([
      ["error", 'label group "Agent phase" lacks "awaiting-approval", "shipping", "blocked", "ready-to-merge"'],
      ["error", 'label group "Agent runtime" does not exist in Linear team DEMO'],
    ]);
  });

  test("creating the missing labels puts new groups in the program's team and values under their group", async () => {
    const linear = fakeLinearLabels([
      group("g-shared", "Agent phase", null),
      value("v1", "planning", "g-shared", null),
    ]);
    const opts = { apiKey: "k", fetch: linear.fetch };
    const created = await createMissingLabels(await readLabels(demoConfig(), opts), opts);
    expect(created).toEqual([
      "Agent phase / awaiting-approval",
      "Agent phase / implementing",
      "Agent phase / shipping",
      "Agent phase / blocked",
      "Agent phase / ready-to-merge",
      "Agent runtime",
      "Agent runtime / Claude Code",
      "Agent runtime / Codex",
      "Agent runtime / Conductor",
    ]);
    expect(linear.created[0]).toEqual({ name: "awaiting-approval", parentId: "g-shared" });
    expect(linear.created[5]).toEqual({
      name: "Agent runtime",
      teamId: DEMO_TEAM.id,
      isGroup: true,
      groupType: "singleSelect",
    });
    expect(linear.created[6]).toEqual({ name: "Claude Code", parentId: "label-8", teamId: DEMO_TEAM.id });
    expect(checkLabels(await readLabels(demoConfig(), opts)).every((c) => c.level === "ok")).toBe(true);
  });
});
