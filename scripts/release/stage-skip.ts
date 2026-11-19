import { appendFile } from "node:fs/promises";
import { matchesDeploymentHealth } from "./deployment-health";
import { authenticateReleaseCompletion, type ReceiptRun } from "./smoke-receipt";

const releaseStages = ["check", "binaries", "staging-smoke", "production", "npm"] as const;

type ReleaseStage = (typeof releaseStages)[number];

interface ReleaseJob {
  name: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
}

interface StatusSnapshot {
  sha: string;
  statuses: readonly { context: string; state: string; target_url: string; description?: string }[];
}

export function completedStages(sha: string, snapshot: StatusSnapshot, runUrlPrefix: string) {
  const receipts = new Map<ReleaseStage, { run: string; description: string | undefined }>();
  if (snapshot.sha !== sha) return receipts;
  for (const stage of releaseStages) {
    const status = snapshot.statuses.find(({ context }) => context === `release/${stage}`);
    if (status?.state !== "success" || !status.target_url?.startsWith(runUrlPrefix)) continue;
    const run = status.target_url.slice(runUrlPrefix.length);
    if (/^[1-9][0-9]*$/.test(run)) receipts.set(stage, { run, description: status.description });
  }
  return receipts;
}

export function recordedStageSucceeded(
  jobs: readonly ReleaseJob[],
  run: { id: number; head_sha: string },
  stage: ReleaseStage,
  sha: string,
  description?: string,
) {
  const image = stage === "staging-smoke" ? `, ${description}` : "";
  const name = `Record release/${stage} success (${sha}${image})`;
  const runJobs = jobs.filter((job) => job.run_id === run.id && job.head_sha === run.head_sha);
  const records = runJobs.filter(
    (job) =>
      job.conclusion === "success" && job.steps?.some((step) => step.name === name && step.conclusion === "success"),
  );
  if (stage !== "binaries") return records.length > 0;
  const receiptAttempt = Math.max(...records.map((job) => job.run_attempt));
  return (
    Number.isSafeInteger(receiptAttempt) &&
    !runJobs.some(
      (job) =>
        job.run_attempt > receiptAttempt &&
        job.conclusion !== "skipped" &&
        (job.name.startsWith("Binary (") || job.name === "Build candidate sandbox image (linux/amd64)"),
    )
  );
}

interface RailwayDeployment {
  status: string;
  meta?: { commitMessage?: string };
}

export function canReuseServer(
  deployment: RailwayDeployment | null,
  message: string,
  health: unknown,
  version: string,
  sha: string,
) {
  return (
    deployment?.status === "SUCCESS" &&
    deployment.meta?.commitMessage === message &&
    matchesDeploymentHealth(health, version, sha)
  );
}

export function canReuseDashboard(project: unknown, sha: string) {
  const production = (
    project as { targets?: { production?: { readyState?: string; meta?: { githubCommitSha?: string } } } } | null
  )?.targets?.production;
  return /^[a-f0-9]{40}$/.test(sha) && production?.readyState === "READY" && production.meta?.githubCommitSha === sha;
}

if (import.meta.main) {
  const { RELEASE_SHA = "", RELEASE_VERSION = "", GITHUB_OUTPUT, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  const [mode, latestDeployment, message] = process.argv.slice(2);
  if (mode === "server") {
    const deployment = JSON.parse(latestDeployment ?? "null") as RailwayDeployment | null;
    const health: unknown = await Bun.stdin.json().catch(() => null);
    process.exit(canReuseServer(deployment, message ?? "", health, RELEASE_VERSION, RELEASE_SHA) ? 0 : 1);
  }
  if (mode === "dashboard") {
    const { VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID } = process.env;
    const url = new URL(`/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID ?? "")}`, "https://api.vercel.com");
    if (VERCEL_ORG_ID?.startsWith("team_")) url.searchParams.set("teamId", VERCEL_ORG_ID);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const project: unknown = response?.ok ? await response.json().catch(() => null) : null;
    process.exit(canReuseDashboard(project, RELEASE_SHA) ? 0 : 1);
  }

  if (mode !== "receipts" || !GITHUB_OUTPUT || !GITHUB_SERVER_URL || !GITHUB_REPOSITORY) {
    throw new Error("Missing release receipt context");
  }
  const { GH_TOKEN, GITHUB_API_URL } = process.env;
  if (!GH_TOKEN || !GITHUB_API_URL) throw new Error("Missing GitHub release receipt credentials");
  const prefix = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/`;
  const receipts = completedStages(RELEASE_SHA, await Bun.stdin.json(), prefix);

  async function github<T>(path: string) {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`Release receipt API failed (${response.status})`);
    return (await response.json()) as T;
  }

  async function inspectRun(id: string) {
    const run = await github<ReceiptRun & { id: number; head_sha: string }>(`actions/runs/${id}`);
    if (
      !run ||
      String(run.id) !== id ||
      run.head_branch !== "main" ||
      !authenticateReleaseCompletion(run, GITHUB_REPOSITORY ?? "")
    )
      return;
    const result = await github<{ total_count: number; jobs: ReleaseJob[] }>(
      `actions/runs/${id}/jobs?filter=all&per_page=100`,
    );
    if (result && result.jobs.length === result.total_count) return { run, jobs: result.jobs };
  }

  const evidence = new Map<string, ReturnType<typeof inspectRun>>();
  for (const { run } of receipts.values()) {
    if (!evidence.has(run)) evidence.set(run, inspectRun(run));
  }
  await Promise.all(evidence.values());
  const outputs = [];
  for (const [stage, { run, description }] of receipts) {
    const source = await evidence.get(run);
    if (!source || !recordedStageSucceeded(source.jobs, source.run, stage, RELEASE_SHA, description)) continue;
    console.log(`Recorded success for release/${stage} at ${RELEASE_SHA}: ${prefix}${run}`);
    outputs.push(`${stage}=${run}`);
    if (stage === "check" || stage === "production" || stage === "npm") {
      console.log(`Skipping release/${stage} using recorded success.`);
    }
    if (stage === "staging-smoke" && /^(?:none|sha256:[a-f0-9]{64})$/.test(description ?? "")) {
      outputs.push(`staging-digest=${description}`);
    }
  }
  if (outputs.length) await appendFile(GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
}
