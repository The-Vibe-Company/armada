import { expect, test } from "bun:test";
import { buildModel } from "../src/model.ts";
import { buildOverview } from "../src/overview.ts";
import { planRenumber, planSpecInsert } from "../src/specs.ts";
import { buildStatus } from "../src/status.ts";
import { demoConfig, issue, NOW } from "./support.ts";

const specs = (...titles: string[]) =>
  buildModel(
    [
      issue("DEMO-1"),
      ...titles.map((title, i) => issue(`DEMO-${i + 2}`, { uuid: `spec-${i + 1}`, title, parentId: "DEMO-1" })),
    ],
    "DEMO-1",
  ).specs;

test("append in N style leaves every legacy title alone and includes the In short template", () => {
  const input = specs("Spec 1/2 — Login", "Spec 2/2 — Images");
  const before = structuredClone(input);
  const plan = planSpecInsert(input, " Search images ", null, "N");
  expect(plan.create?.title).toBe("Spec 3 — Search images");
  expect(plan.create?.description).toContain("## In short");
  for (const field of ["What changes", "Why", "Done when", "Depends on"])
    expect(plan.create?.description).toContain(field);
  expect(plan.renames).toEqual([]);
  expect(input).toEqual(before);
});

test("insertion shifts only the suffix and does not bump legacy totals in N style", () => {
  expect(
    planSpecInsert(specs("Spec 1/3 — Login", "Spec 2 — Images", "Spec 3/3 — Search"), "Files", 2, "N"),
  ).toMatchObject({
    create: { title: "Spec 2 — Files" },
    renames: [
      { uuid: "spec-3", from: "Spec 3/3 — Search", to: "Spec 4/3 — Search" },
      { uuid: "spec-2", from: "Spec 2 — Images", to: "Spec 3 — Images" },
    ],
  });
});

test("N/M explicitly bumps every total, including titles before an insert", () => {
  expect(planSpecInsert(specs("Spec 1/2 — Login", "Spec 2 — Images"), "Files", 2, "N/M")).toMatchObject({
    create: { title: "Spec 2/3 — Files" },
    renames: [
      { uuid: "spec-2", from: "Spec 2 — Images", to: "Spec 3/3 — Images" },
      { uuid: "spec-1", from: "Spec 1/2 — Login", to: "Spec 1/3 — Login" },
    ],
  });
});

test("append uses the largest ordinal, including gaps, and empty programs start at one", () => {
  expect(planSpecInsert(specs("Spec 2 — Login", "Spec 7 — Files"), "Images", null, "N").create?.title).toBe(
    "Spec 8 — Images",
  );
  expect(planSpecInsert([], "Login", null, "N/M").create?.title).toBe("Spec 1/1 — Login");
});

test("renumber fixes gaps, duplicates and stale totals in stable order", () => {
  const input = specs("Spec 4/9 — Login", "Spec 4/9 — Images", "Spec 9 — Search");
  expect(planRenumber([...input].reverse(), "N/M")).toEqual({
    create: null,
    renames: [
      { uuid: "spec-1", from: "Spec 4/9 — Login", to: "Spec 1/3 — Login" },
      { uuid: "spec-2", from: "Spec 4/9 — Images", to: "Spec 2/3 — Images" },
      { uuid: "spec-3", from: "Spec 9 — Search", to: "Spec 3/3 — Search" },
    ],
  });
  expect(planRenumber(specs("Spec 1/9 — Login", "Spec 2 — Images"), "N").renames).toEqual([
    { uuid: "spec-1", from: "Spec 1/9 — Login", to: "Spec 1 — Login" },
  ]);
  expect(planRenumber([], "N")).toEqual({ create: null, renames: [] });
  expect(planRenumber(specs("Spec 1 — Login"), "N").renames).toEqual([]);
});

test("invalid positions, names and unsafe ordinals fail before producing a write plan", () => {
  for (const at of [0, -1, 1.5, 3, NaN])
    expect(() => planSpecInsert(specs("Spec 1 — Login"), "Files", at, "N")).toThrow();
  for (const name of ["", "  ", "Files\nSearch"]) expect(() => planSpecInsert([], name, null, "N")).toThrow();
  expect(() => planSpecInsert(specs(`Spec ${Number.MAX_SAFE_INTEGER} — Login`), "Files", null, "N")).toThrow();
});

test("mixed spec titles give status and overview their spec labels and preserve frontier ordinal order", () => {
  const report = buildStatus({
    config: demoConfig(),
    forge: null,
    now: NOW,
    program: {
      rootId: "DEMO-1",
      fetchedAt: NOW.toISOString(),
      comments: [],
      warnings: [],
      issues: [
        issue("DEMO-1"),
        issue("DEMO-2", { title: "Spec 1 — Login", parentId: "DEMO-1" }),
        issue("DEMO-3", { title: "Spec 2/2 – Search", parentId: "DEMO-1" }),
        issue("DEMO-4", { parentId: "DEMO-2", statusType: "started", agentPhase: "implementing" }),
        issue("DEMO-5", { parentId: "DEMO-3", statusType: "started", agentPhase: "implementing" }),
        issue("DEMO-20", { parentId: "DEMO-2", labels: ["ready-for-agent"] }),
        issue("DEMO-10", { parentId: "DEMO-3", labels: ["ready-for-agent"] }),
      ],
    },
  });
  expect(report.inFlight.map((t) => t.spec).sort()).toEqual(["Spec 1", "Spec 2"]);
  expect(report.frontier.map((t) => [t.id, t.spec])).toEqual([
    ["DEMO-20", "Spec 1"],
    ["DEMO-10", "Spec 2"],
  ]);
  const overview = buildOverview({
    now: NOW,
    live: { state: "off", error: null },
    projects: [
      {
        slug: "widgets",
        name: "Widgets",
        repository: "acme/widgets",
        report,
        error: null,
        live: null,
      },
    ],
  });
  expect(overview.rows.map((t) => t.spec).sort()).toEqual(["Spec 1", "Spec 2"]);
  expect(overview.ready.map((t) => t.id)).toEqual(["DEMO-20", "DEMO-10"]);
});
