import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("journal restore rejects untrusted artifact producers before downloading deletion authority", () => {
  {
    const workflow = "staging-gated-production";
    const config = Bun.YAML.parse(readFileSync(`.github/workflows/${workflow}.yml`, "utf8")) as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
    };
    const script = Object.values(config.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Restore staging smoke receipts across branches and tags")?.run;
    expect(script).toBeDefined();
    for (const [event, repo, branch, path, allowed] of [
      ["push", "owner/repo", "main", ".github/workflows/staging-gated-production.yml", true],
      ["schedule", "owner/repo", "main", ".github/workflows/staging-gated-production.yml", true],
      ["push", "owner/repo", "v2.26.0", ".github/workflows/release.yml", true],
      ["deployment_status", "owner/repo", "main", ".github/workflows/post-deploy-smoke.yml", true],
      ["pull_request", "owner/repo", "main", ".github/workflows/post-deploy-smoke.yml", false],
      ["push", "fork/repo", "main", ".github/workflows/post-deploy-smoke.yml", false],
      ["push", "owner/repo", "feature", ".github/workflows/post-deploy-smoke.yml", false],
      ["push", "owner/repo", "main", ".github/workflows/other.yml", false],
    ] as const) {
      const directory = mkdtempSync(join(tmpdir(), "smoke-restore-"));
      try {
        writeFileSync(
          join(directory, "run.json"),
          JSON.stringify({ event, head_repository: { full_name: repo }, head_branch: branch, path }),
        );
        writeFileSync(
          join(directory, "gh"),
          `#!/bin/bash\ncase "$2" in\n *'actions/artifacts?'*) echo '{"artifacts":[{"id":9,"workflow_run":{"id":9,"head_repository_id":2,"repository_id":1,"head_branch":"main"}},{"id":1,"workflow_run":{"id":2,"head_repository_id":1,"repository_id":1,"head_branch":"main"}}]}' ;;\n */actions/runs/*) cat "$RUNNER_TEMP/run.json" ;;\n */artifacts/1/zip) touch "$RUNNER_TEMP/downloaded" ;;\n *) exit 99 ;;\nesac\n`,
        );
        writeFileSync(join(directory, "unzip"), '#!/bin/bash\necho "[]"\n');
        for (const command of ["gh", "unzip"]) chmodSync(join(directory, command), 0o755);
        const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script ?? "exit 99"], {
          cwd: directory,
          env: { PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, GH_REPO: "owner/repo" },
        });
        expect(result.exitCode === 0).toBe(allowed);
        expect(existsSync(join(directory, "downloaded"))).toBe(allowed);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});
