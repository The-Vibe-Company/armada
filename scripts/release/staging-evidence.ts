import { matchesDeploymentHealth } from "./deployment-health.ts";

/** Only completed ordinary main runs with real deployment and smoke authorize reuse. */
export function authenticStagingEvidence(
  run: Record<string, unknown>,
  jobs: Record<string, unknown>[],
  repository: string,
  sha: string,
  deployedAfter?: string,
): boolean {
  const head = run.head_repository as { full_name?: string } | undefined;
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    head?.full_name !== repository ||
    run.path !== ".github/workflows/staging-gated-production.yml" ||
    (run.event !== "workflow_run" && run.event !== "push") ||
    run.head_branch !== "main" ||
    (run.event === "push" && run.head_sha !== sha) ||
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
    job.head_sha !== run.head_sha ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Array.isArray(job.steps)
  )
    return false;
  const successfulStep = (name: string) => {
    const steps = (job.steps as Record<string, unknown>[]).filter((step) => step.name === name);
    const step = steps[0];
    return steps.length === 1 && step?.status === "completed" && step.conclusion === "success" ? step : undefined;
  };
  const deploymentName = "Migrate then deploy pinned server and dashboard";
  const deployment = successfulStep(run.event === "workflow_run" ? `${deploymentName} (${sha})` : deploymentName);
  if (!deployment || !successfulStep("Smoke pinned staging")) return false;
  if (deployedAfter === undefined) return true;
  return Date.parse(String(deployment.started_at ?? "")) >= Date.parse(deployedAfter);
}

/** A wakeup can reuse a successful deployment only while that exact source is live. */
export function authenticWakeupEvidence(
  run: Record<string, unknown>,
  jobs: Record<string, unknown>[],
  repository: string,
  sha: string,
  health: unknown,
  version: string,
  deployedAfter: string,
): boolean {
  return (
    authenticStagingEvidence(run, jobs, repository, sha, deployedAfter) && matchesDeploymentHealth(health, version, sha)
  );
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
    const release = (await Bun.file(process.env.GITHUB_EVENT_PATH as string).json()).workflow_run;
    // A newer completion can supersede a failed Release's queued wakeup.
    // Evidence must postdate the surviving completion to cover earlier writes.
    const deployedAfter = String(release?.updated_at ?? "");
    const response = await fetch(`${process.env.ARMADA_SERVER_URL?.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Staging source identity unavailable");
    const health: unknown = await response.json();
    const version = process.env.RELEASE_VERSION ?? "";
    if (!matchesDeploymentHealth(health, version, sha)) throw new Error("Staging is on another source");
    const runs = await api<{ workflow_runs: (Record<string, unknown> & { id: number; run_attempt: number })[] }>(
      `actions/workflows/staging-gated-production.yml/runs?branch=main&status=success&per_page=20`,
    );
    for (const run of runs.workflow_runs ?? []) {
      // Fetch only jobs for the current attempt, never mix successful old steps
      // with a later failed/skipped attempt.
      const result = await api<{ total_count: number; jobs: Record<string, unknown>[] }>(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      if (result.total_count > 100) continue;
      if (authenticWakeupEvidence(run, result.jobs, repository, sha, health, version, deployedAfter)) {
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
