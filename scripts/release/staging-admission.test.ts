import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Workflow {
  on: { push: { branches: string[] }; workflow_run: { workflows: string[]; types: string[] } };
  concurrency: { group: string; queue?: string; "cancel-in-progress": boolean };
  jobs: { staging: { concurrency: Workflow["concurrency"]; steps: { id?: string; run?: string; if?: string }[] } };
}

const release = Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")) as Workflow;
const staging = Bun.YAML.parse(readFileSync(".github/workflows/staging-gated-production.yml", "utf8")) as Workflow;

test("push, quick Release and completion wakeup retain serialized newest-main admission", () => {
  // Scheduler contract: both events coalesce, completion always wakes, and an
  // admitted job cannot turn stale API queue rows into a terminal no-op.
  expect(staging.on.push.branches).toEqual(["main"]);
  expect(staging.on.workflow_run).toEqual({ workflows: ["Release"], types: ["completed"] });
  expect(staging.concurrency["cancel-in-progress"]).toBe(false);
  expect(staging.concurrency.group).toContain("staging-main-latest");
  expect(release.concurrency).toEqual({ group: "release-production", queue: "max", "cancel-in-progress": false });
  expect(staging.jobs.staging.concurrency.group).toContain("'release-production'");
  expect(staging.jobs.staging.concurrency["cancel-in-progress"]).toBe(false);
  const admission = staging.jobs.staging.steps.find((step) => step.id === "admission");
  expect(admission?.run).not.toContain("staging-admission.ts");
  expect(staging.jobs.staging.steps.some((step) => step.if?.includes("outputs.deferred"))).toBe(false);
});
