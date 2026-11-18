import { matchesDeploymentHealth } from "./deployment-health.ts";

/** Only completed ordinary main runs with real deployment and smoke authorize reuse. */
export function authenticStagingEvidence(
  run: Record<string, unknown>,
  jobs: Record<string, unknown>[],
  repository: string,
  sha: string,
): boolean {
  const head = run.head_repository as { full_name?: string } | undefined;
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    head?.full_name !== repository ||
    run.path !== ".github/workflows/staging-gated-production.yml" ||
    (run.event !== "workflow_run" && run.event !== "push") ||
    run.head_branch !== "main" ||
    run.head_sha !== sha ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.run_attempt)
  )
    return false;
  const staging = jobs.filter((job) => job.name === "staging");
  if (staging.length !== 1) return false;
  const job = staging[0];
  if (
    !job ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== sha ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Array.isArray(job.steps)
  )
    return false;
  return ["Migrate then deploy pinned server and dashboard", "Smoke pinned staging"].every((name) => {
    const steps = (job.steps as Record<string, unknown>[]).filter((step) => step.name === name);
    return steps.length === 1 && steps[0]?.status === "completed" && steps[0]?.conclusion === "success";
  });
}

/** A wakeup can reuse a successful deployment only while that exact source is live. */
export function authenticWakeupEvidence(
  run: Record<string, unknown>,
  jobs: Record<string, unknown>[],
  repository: string,
  sha: string,
  health: unknown,
  version: string,
): boolean {
  return authenticStagingEvidence(run, jobs, repository, sha) && matchesDeploymentHealth(health, version, sha);
}

if (import.meta.main) {
  // API failures, missing runs (including GITHUB_TOKEN tags), and pagination
  // uncertainty are cache misses, never release authorization failures.
  const { GITHUB_REPOSITORY: repository, RELEASE_SHA: sha, GH_TOKEN: token } = process.env;
  let reused = false;
  try {
    if (!repository || !sha || !token) throw new Error("Missing evidence lookup context");
    const api = async <T>(path: string): Promise<T> => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Evidence API unavailable");
      return (await response.json()) as T;
    };
    const runs = await api<{ workflow_runs: (Record<string, unknown> & { id: number; run_attempt: number })[] }>(
      `actions/workflows/staging-gated-production.yml/runs?branch=main&head_sha=${encodeURIComponent(sha)}&status=success&per_page=20`,
    );
    const response = await fetch(`${process.env.ARMADA_SERVER_URL?.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Staging source identity unavailable");
    const health: unknown = await response.json();
    for (const run of runs.workflow_runs ?? []) {
      // Fetch only jobs for the current attempt, never mix successful old steps
      // with a later failed/skipped attempt.
      const result = await api<{ total_count: number; jobs: Record<string, unknown>[] }>(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      if (result.total_count > 100) continue;
      if (authenticWakeupEvidence(run, result.jobs, repository, sha, health, process.env.RELEASE_VERSION ?? "")) {
        console.log(`Reusing authenticated staging run ${run.id} for ${sha}`);
        reused = true;
        break;
      }
    }
  } catch {
    console.log("No reusable staging evidence; continuing ordinary staging.");
  }
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT as string, `reused=${reused}\n`);
}
