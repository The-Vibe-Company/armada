import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the CLI with fixed historical completion times: no network or sleeps.
test("budget guard rejects late, failed, missing and queued verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-budget-"));
  try {
    const start = Date.now() - 60_000;
    const success = {
      name: "Unit tests (1/12)",
      conclusion: "success",
      completed_at: new Date(start + 50_000).toISOString(),
    };
    const runGuard = (jobs: readonly unknown[], startedAt = start) => {
      writeFileSync(join(dir, "run.json"), JSON.stringify({ run_started_at: new Date(startedAt).toISOString() }));
      writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobs));
      return Bun.spawnSync(["node", "scripts/ci/check-budget.cjs", join(dir, "run.json"), join(dir, "jobs.json")], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary") },
      }).exitCode;
    };
    for (const [jobs, expected] of [
      [[success], 0],
      [
        [
          success,
          { name: "Informational Golden OS recipe (actual provider image)", conclusion: null, status: "in_progress" },
        ],
        0,
      ],
      [
        [
          success,
          {
            name: "Informational Golden OS recipe (actual provider image)",
            conclusion: "failure",
            completed_at: new Date(start + 190_000).toISOString(),
          },
        ],
        0,
      ],
      [[{ ...success, completed_at: new Date(start + 121_000).toISOString() }], 1],
      [[{ ...success, conclusion: "failure" }], 1],
      [[{ ...success, conclusion: null, status: "queued" }], 1],
      [[success, { name: "Lint, typecheck and test", conclusion: null, status: "in_progress" }], 1],
      // Informational and budget jobs cannot extend the required path.
      [[success, { name: "CI budget (120s)", status: "in_progress", conclusion: null }], 0],
      [[success, { name: "Another informational job", conclusion: "failure" }], 0],
      [[{ ...success, completed_at: undefined }], 1],
      [[], 1],
    ] as const) {
      expect(runGuard(jobs)).toBe(expected);
    }
    // The diagnostic runner starts ten minutes later; admission still completed in 110s.
    const historicalStart = Date.now() - 600_000;
    expect(
      runGuard([{ ...success, completed_at: new Date(historicalStart + 110_000).toISOString() }], historicalStart),
    ).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
