import { expect, test } from "bun:test";

test("journal restoration authenticates producers before download and full provenance before deletion authority", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/staging-gated-production.yml").text()) as {
    jobs: { staging: { steps: { name?: string; run?: string }[] } };
  };
  const script = workflow.jobs.staging.steps.find(
    (step: { name?: string }) => step.name === "Restore staging smoke receipts across branches and tags",
  )?.run;
  if (!script) throw new Error("Missing receipt restoration script");
  const producer = script.indexOf("bun .release-tools/scripts/release/smoke-receipt.ts --producer-only");
  const download = script.indexOf('gh api "repos/$GH_REPO/actions/artifacts/$artifact/zip"');
  const provenance = script.indexOf(
    'bun .release-tools/scripts/release/smoke-receipt.ts "$RUNNER_TEMP/receipt-run.json"',
  );
  const authority = script.indexOf('unzip -p "$RUNNER_TEMP/smoke-journal.zip" sandboxes.json');
  expect(producer).toBeGreaterThan(-1);
  expect(download).toBeGreaterThan(producer);
  expect(provenance).toBeGreaterThan(download);
  expect(authority).toBeGreaterThan(provenance);
});
