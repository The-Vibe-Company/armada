import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the CLI with fixed historical completion times: no network or sleeps.
test("budget guard rejects late, failed, missing and queued verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-budget-"));
  try {
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_started_at: new Date(start).toISOString() }));
    const success = {
      name: "Unit tests (1/12)",
      conclusion: "success",
      completed_at: new Date(start + 50_000).toISOString(),
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
      [[], 1],
    ] as const) {
      writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobs));
      const result = Bun.spawnSync(
        ["node", "scripts/ci/check-budget.cjs", join(dir, "run.json"), join(dir, "jobs.json")],
        {
          env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary") },
        },
      );
      expect(result.exitCode).toBe(expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
