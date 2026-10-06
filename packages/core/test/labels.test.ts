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
        missing: ["awaiting-approval", "shipping", "blocked", "ready-to-merge", "awaiting-validation"],
      },
      { name: "Agent runtime", id: null, scope: null, missing: ["Claude Code", "Codex", "Conductor", "Herdr"] },
    ]);
    expect(checkLabels(state).map((c) => [c.level, c.message])).toEqual([
      [
        "error",
        'label group "Agent phase" lacks "awaiting-approval", "shipping", "blocked", "ready-to-merge", "awaiting-validation"',
      ],
      ["error", 'label group "Agent runtime" does not exist in Linear team DEMO'],
      ["error", 'label "plan-approved" does not exist in Linear team DEMO'],
      ["error", 'label "needs-plan-approval" does not exist in Linear team DEMO'],
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
      "Agent phase / awaiting-validation",
      "Agent runtime",
      "Agent runtime / Claude Code",
      "Agent runtime / Codex",
      "Agent runtime / Conductor",
      "Agent runtime / Herdr",
      "plan-approved",
      "needs-plan-approval",
    ]);
    expect(linear.created[0]).toEqual({ name: "awaiting-approval", parentId: "g-shared" });
    expect(linear.created[6]).toEqual({
      name: "Agent runtime",
      teamId: DEMO_TEAM.id,
      isGroup: true,
      groupType: "singleSelect",
    });
    expect(linear.created[7]).toEqual({ name: "Claude Code", parentId: "label-9", teamId: DEMO_TEAM.id });
    expect(checkLabels(await readLabels(demoConfig(), opts)).every((c) => c.level === "ok")).toBe(true);
  });
});

test("policy plan labels are checked, created as plain team labels, and left unchanged when present", async () => {
  for (const names of [
    ["plan-approved", "needs-plan-approval"],
    ["Plan accepted", "Plan review"],
    ["", ""],
  ]) {
    const config = demoConfig();
    [config.policy.preApprovedLabel, config.policy.approvalLabel] = names as [string, string];
    const wanted = names.filter(Boolean);
    const linear = fakeLinearLabels(
      wanted.flatMap((name, i) => [
        { ...group(`other-${i}`, name, "team-other"), isGroup: false },
        group(`group-${i}`, name, DEMO_TEAM.id),
      ]),
    );
    const opts = { apiKey: "k", fetch: linear.fetch };
    const missing = await readLabels(config, opts);
    expect(checkLabels(missing).filter((c) => wanted.some((name) => c.id === `labels:${name}`))).toEqual(
      wanted.map((name) => ({
        id: `labels:${name}`,
        level: "error",
        message: `label "${name}" does not exist in Linear team DEMO`,
        fix: "run `armada init` to create it",
      })),
    );
    await createMissingLabels(missing, opts);
    expect(linear.created.filter((l) => wanted.includes(String(l.name)))).toEqual(
      wanted.map((name) => ({ name, teamId: DEMO_TEAM.id })),
    );
    expect(checkLabels(await readLabels(config, opts)).every((c) => c.level === "ok")).toBe(true);
    const count = linear.created.length;
    expect(await createMissingLabels(await readLabels(config, opts), opts)).toEqual([]);
    expect(linear.created).toHaveLength(count);

    // Existing shared labels apply too, regardless of case.
    for (const label of linear.labels.filter(
      (l) => wanted.includes(l.name) && !l.isGroup && l.teamId === DEMO_TEAM.id,
    )) {
      label.teamId = null;
      label.name = label.name.toUpperCase();
    }
    expect(await createMissingLabels(await readLabels(config, opts), opts)).toEqual([]);
  }
});

test("label-group reads retry temporary failures while label creation is sent only once", async () => {
  const linear = fakeLinearLabels([]);
  let reads = 0;
  let writes = 0;
  const waits: number[] = [];
  const opts = {
    apiKey: "synthetic-key",
    random: () => 0.5,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    fetch: async (url: string, init: RequestInit) => {
      if (String(init.body).includes("query Labels")) {
        if (++reads <= 2) return new Response("busy", { status: 503 });
        return linear.fetch(url, init);
      }
      writes++;
      return new Response("busy", { status: 503 });
    },
  };
  const state = await readLabels(demoConfig(), opts);
  expect(state.team.id).toBe(DEMO_TEAM.id);
  expect(reads).toBe(3);
  expect(waits).toEqual([1000, 3000]);
  await expect(createMissingLabels(state, opts)).rejects.toThrow("HTTP 503");
  expect(writes).toBe(1);
});
