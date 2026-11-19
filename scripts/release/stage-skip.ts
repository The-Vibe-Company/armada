import { matchesDeploymentHealth } from "./deployment-health";

export const releaseStages = ["check", "binaries", "staging-smoke", "production", "npm"] as const;

interface StatusSnapshot {
  sha: string;
  statuses: readonly { context: string; state: string; target_url: string; description?: string }[];
}

export function completedStages(sha: string, snapshot: StatusSnapshot, runUrlPrefix: string) {
  const receipts = new Map<(typeof releaseStages)[number], { run: string; description?: string }>();
  if (snapshot.sha !== sha) return receipts;
  for (const stage of releaseStages) {
    const status = snapshot.statuses.find(({ context }) => context === `release/${stage}`);
    if (status?.state !== "success" || !status.target_url?.startsWith(runUrlPrefix)) continue;
    const run = status.target_url.slice(runUrlPrefix.length);
    if (/^[1-9][0-9]*$/.test(run)) receipts.set(stage, { run, description: status.description });
  }
  return receipts;
}

export function canReuseServer(status: string, health: unknown, version: string, sha: string) {
  return status === "SUCCESS" && matchesDeploymentHealth(health, version, sha);
}

export function canReuseDashboard(project: unknown, sha: string) {
  const production = (
    project as { targets?: { production?: { readyState?: string; meta?: { githubCommitSha?: string } } } } | null
  )?.targets?.production;
  return /^[a-f0-9]{40}$/.test(sha) && production?.readyState === "READY" && production.meta?.githubCommitSha === sha;
}

if (import.meta.main) {
  const { RELEASE_SHA = "", RELEASE_VERSION = "", GITHUB_OUTPUT, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  const [mode, railwayStatus] = process.argv.slice(2);
  if (mode === "server") {
    const health: unknown = await Bun.stdin.json().catch(() => null);
    process.exit(canReuseServer(railwayStatus ?? "", health, RELEASE_VERSION, RELEASE_SHA) ? 0 : 1);
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
  const prefix = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/`;
  const receipts = completedStages(RELEASE_SHA, await Bun.stdin.json(), prefix);
  const outputs = [];
  for (const [stage, { run, description }] of receipts) {
    console.log(`Recorded success for release/${stage} at ${RELEASE_SHA}: ${prefix}${run}`);
    outputs.push(`${stage}=${run}`);
    if (stage === "staging-smoke" && /^(?:none|sha256:[a-f0-9]{64})$/.test(description ?? "")) {
      outputs.push(`staging-digest=${description}`);
    }
  }
  await Bun.write(GITHUB_OUTPUT, `${await Bun.file(GITHUB_OUTPUT).text()}${outputs.join("\n")}\n`);
}
