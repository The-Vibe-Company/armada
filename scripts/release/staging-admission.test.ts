import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Concurrency = { group: string; queue?: string; "cancel-in-progress": boolean };

interface Workflow {
  on: { push?: { branches: string[] }; workflow_run?: { workflows: string[]; types: string[] } };
  concurrency: Concurrency;
  jobs: { staging: { concurrency: Workflow["concurrency"]; steps: { id?: string; run?: string; if?: string }[] } };
}

const release = Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")) as {
  on: Workflow["on"];
  concurrency?: Concurrency;
  jobs: Record<string, { concurrency?: Concurrency; if?: string; uses?: string }>;
};
const staging = Bun.YAML.parse(readFileSync(".github/workflows/staging-gated-production.yml", "utf8")) as Workflow;

test("only Release completion automatically wakes serialized newest-main staging", () => {
  // Main pushes enter through Release completion, and an
  // admitted job cannot turn stale API queue rows into a terminal no-op.
  expect(release.on.push?.branches).toEqual(["main"]);
  expect(Object.keys(staging.on).sort()).toEqual(["workflow_call", "workflow_dispatch", "workflow_run"]);
  expect(staging.on.workflow_run).toEqual({ workflows: ["Release"], types: ["completed"] });
  expect(staging.concurrency["cancel-in-progress"]).toBe(false);
  expect(staging.concurrency.group).toContain("staging-main-latest");
  expect(staging.jobs.staging.concurrency.group).toContain("'release-production'");
  expect(staging.jobs.staging.concurrency["cancel-in-progress"]).toBe(false);
  const admission = staging.jobs.staging.steps.find((step) => step.id === "admission");
  expect(admission?.run).not.toContain("staging-admission.ts");
  expect(staging.jobs.staging.steps.some((step) => step.if?.includes("outputs.deferred"))).toBe(false);
});

test("only the publishing call queues for the shared staging lock", () => {
  expect(release.concurrency).toBeUndefined();
  expect(release.jobs["publication-intent"]?.concurrency?.group ?? "").not.toContain("release-production");
  expect(release.jobs["release-please"]?.concurrency?.group ?? "").not.toContain("release-production");
  expect(release.jobs["release-pipeline"]).toEqual(
    expect.objectContaining({
      if: "needs.publication-intent.outputs.publish == 'true' || needs.publication-intent.outputs.mode == 'dry-run'",
      uses: "./.github/workflows/release-pipeline.yml",
      concurrency: {
        group: `\${{ needs.publication-intent.outputs.publish == 'true' && 'release-production' || format('release-dry-run-{0}', github.run_id) }}`,
        queue: "max",
        "cancel-in-progress": false,
      },
    }),
  );
});
