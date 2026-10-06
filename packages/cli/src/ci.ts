import {
  type ArmadaConfig,
  type Credentials,
  type Explanation,
  explainChecks,
  FULL_SHA,
  fetchBranchHead,
  fetchFailedChecks,
  fetchJobLog,
  fetchPullRequest,
  fetchRunAttempt,
  type JobLog,
  parsePullRequestUrl,
} from "@armada/core";
import { httpOptions, type Io, UsageError } from "./io.ts";

const LABELS: Record<Explanation["class"], string> = {
  known: "known flaky test",
  runner: "runner problem",
  failure: "failure",
  external: "external check",
};

/** At most 47 lines per check, including the first error block and its link. */
export function renderCiWhy(sha: string, explanations: readonly Explanation[]): string {
  const lines = [`CI on ${sha}`];
  if (!explanations.length) lines.push("No failing checks reported on this head.");
  for (const e of explanations) {
    lines.push(
      "",
      `${e.check}: ${e.superseded ? "superseded by a newer head" : LABELS[e.class]} (${e.conclusion.toLowerCase()}${e.attempt ? `, workflow attempt ${e.attempt}` : ""})`,
    );
    if (e.tests.length) lines.push(`  Tests: ${e.tests.join("; ")}`);
    lines.push(...e.error.map((l) => `  ${l}`));
    if (!e.error.length && !e.superseded) lines.push("  No error details available; open the check link.");
    if (e.known) lines.push(`  Known: ${e.known.ticket} (${e.known.pattern})`);
    if (e.url) lines.push(`  ${e.url}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function ciWhy(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; options: Record<string, string>; json: boolean },
): Promise<number> {
  const [sub, prArg, ...extra] = args.rest;
  const shaArg = args.options.sha;
  const branch = args.options.branch;
  if (sub !== "why" || extra.length || [prArg, shaArg, branch].filter((v) => v !== undefined).length !== 1)
    throw new UsageError("use ci why with exactly one pull request, --sha <sha> or --branch <branch>");
  if (shaArg !== undefined && !FULL_SHA.test(shaArg))
    throw new UsageError("--sha must be a full 40-character commit SHA");
  if (branch !== undefined && !branch.trim()) throw new UsageError("--branch needs a branch name");
  let number: number | undefined;
  if (prArg !== undefined) {
    const parsed = parsePullRequestUrl(prArg);
    if (parsed && parsed.repo.toLowerCase() !== config.github.repository.toLowerCase())
      throw new UsageError("pull request is outside the project repository");
    number = parsed?.number ?? (/^\d+$/.test(prArg) ? Number(prArg) : undefined);
    if (!number || !Number.isSafeInteger(number))
      throw new UsageError("pull request must be a positive number or a GitHub pull request URL");
  }
  const token = credentials.githubToken;
  if (!token)
    throw new UsageError("GITHUB_TOKEN is required for ci why (or sign in with gh auth login)", "gh auth login");
  const opts = { token, repository: config.github.repository, ...httpOptions(io) };
  const head = async () => {
    if (branch) return fetchBranchHead({ ...opts, branch });
    const pull = await fetchPullRequest({ ...opts, number: number as number });
    if (!pull?.headSha) throw new UsageError(`pull request #${number} was not found`);
    return pull.headSha;
  };
  const sha = shaArg ?? (await head());
  const reading = await fetchFailedChecks({ ...opts, sha });
  // A push during diagnosis can cancel the head we pinned above. Never label it a new failure.
  if (!shaArg && reading.checks.some((c) => c.conclusion === "CANCELLED")) {
    const current = await head();
    for (const c of reading.checks) if (c.conclusion === "CANCELLED" && c.headSha !== current) c.superseded = true;
  }
  const logs = new Map<number, JobLog>();
  const attempts = new Map<number, number | null>();
  const warnings = [...reading.warnings];
  for (const check of reading.checks) {
    if (check.app !== "github-actions" || check.superseded) continue;
    if (check.id !== null) {
      const log = await fetchJobLog({ ...opts, jobId: check.id });
      logs.set(check.id, log);
      warnings.push(...log.warnings);
    }
    if (check.runId !== null) {
      if (!attempts.has(check.runId)) {
        try {
          attempts.set(check.runId, await fetchRunAttempt({ ...opts, runId: check.runId }));
        } catch {
          attempts.set(check.runId, null);
          warnings.push(`run ${check.runId}: attempt unavailable; token may need Actions repository permission (read)`);
        }
      }
      check.attempt = attempts.get(check.runId);
    }
  }
  const explanations = explainChecks(reading.checks, logs, config.ci);
  if (args.json) io.stdout(`${JSON.stringify({ sha: reading.sha, explanations, warnings }, null, 2)}\n`);
  else {
    io.stdout(renderCiWhy(reading.sha, explanations));
    for (const w of warnings) io.stderr(`armada: warning: ${w}\n`);
  }
  return 0;
}
