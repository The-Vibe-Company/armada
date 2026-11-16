import { expect, test } from "bun:test";
import { authenticateSmokeReceipt, type ReceiptRun } from "./smoke-receipt.ts";

const repository = "example/armada";
const wakeup: ReceiptRun = {
  event: "workflow_run",
  path: ".github/workflows/staging-gated-production.yml",
  head_branch: "main",
  head_repository: { full_name: repository },
};
const release: ReceiptRun = {
  ...wakeup,
  event: "push",
  path: ".github/workflows/release.yml",
  status: "completed",
};

test("completion receipts remain restorable by the shared ordinary and pinned smoke consumer", () => {
  expect(authenticateSmokeReceipt(wakeup, repository, release)).toBe(true);
  expect(authenticateSmokeReceipt({ ...release, head_branch: "v2.49.4" }, repository)).toBe(true);
  expect(authenticateSmokeReceipt({ ...wakeup, event: "push" }, repository)).toBe(true);
});

test("completion receipt authentication retains repository, workflow and Release provenance boundaries", () => {
  expect(authenticateSmokeReceipt(wakeup, repository)).toBe(false);
  for (const invalid of [
    { ...release, status: "in_progress" },
    { ...release, path: ".github/workflows/ci.yml" },
    { ...release, event: "pull_request" },
    { ...release, head_branch: "feature" },
    { ...release, head_repository: { full_name: "fork/armada" } },
  ]) {
    expect(authenticateSmokeReceipt(wakeup, repository, invalid)).toBe(false);
  }
  expect(authenticateSmokeReceipt({ ...wakeup, head_branch: "feature" }, repository, release)).toBe(false);
  expect(authenticateSmokeReceipt({ ...wakeup, path: ".github/workflows/ci.yml" }, repository, release)).toBe(false);
  expect(authenticateSmokeReceipt({ ...wakeup, head_repository: null }, repository, release)).toBe(false);
});

test("wakeup cleanup uploads retain provenance even when restoration or smoke fails", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../.github/workflows/staging-gated-production.yml", import.meta.url)).text(),
  ) as { jobs: { staging: { steps: { name?: string; uses?: string; run?: string; with?: { path?: string } }[] } } };
  const steps = workflow.jobs.staging.steps;
  const provenance = steps.findIndex((step) => step.name === "Record Release completion provenance");
  const restoration = steps.findIndex(
    (step) => step.name === "Restore staging smoke receipts across branches and tags",
  );
  const smoke = steps.findIndex((step) => step.name === "Smoke pinned staging");
  expect(provenance).toBeGreaterThan(-1);
  expect(provenance).toBeLessThan(restoration);
  expect(restoration).toBeLessThan(smoke);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.with?.path?.split("\n")).toContain(".smoke/release-trigger.json");
  expect(upload?.with?.path?.split("\n")).toContain(".smoke/sandboxes.json");
});
