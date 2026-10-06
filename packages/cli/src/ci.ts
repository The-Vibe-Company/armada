import {
  type ArmadaConfig,
  type Credentials,
  type Explanation,
  explainChecks,
  FULL_SHA,
  fetchBranchHead,
  fetchFailedChecks,
  fetchJobLog,
  fetchJobSteps,
  fetchPullRequest,
  fetchRunAttempt,
  fetchWorkflowRun,
  type JobLog,
  parsePullRequestUrl,
  rerunDecision,
} from "@armada/core";
import { httpOptions, type Io, UsageError } from "./io.ts";

const LABELS: Record<Explanation["class"], string> = {
  known: "known flaky test",
  runner: "runner problem",
  dependent: "ignored as a dependent summary",
  failure: "failure",
  external: "external check",
};

/** Bounded test names and first error block, plus links and matching root-cause tickets. */
export function renderCiWhy(sha: string, explanations: readonly Explanation[]): string {
  const lines = [`CI on ${sha}`];
  if (!explanations.length) lines.push("No failing checks reported on this head.");
  for (const e of explanations) {
    lines.push(
      "",
      `${e.check}: ${e.superseded ? "superseded by a newer head" : LABELS[e.class]} (${e.conclusion.toLowerCase()}${e.attempt ? `, workflow attempt ${e.attempt}` : ""})`,
    );
    if (e.tests.length) lines.push(`  Tests: ${e.tests.join("; ")}`);
    if (e.dependencies?.length) lines.push(`  Dependencies: ${e.dependencies.join("; ")}`);
    lines.push(...e.error.map((l) => `  ${l}`));
    if (!e.error.length && !e.superseded) lines.push("  No error details available; open the check link.");
    for (const k of e.knownMatches ?? (e.known ? [e.known] : [])) lines.push(`  Known: ${k.ticket} (${k.pattern})`);
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
  // Fetch step evidence only when logs contain the explicit dependency-reporting gate.
  for (const check of reading.checks) {
    if (
      check.app !== "github-actions" ||
      check.superseded ||
      check.id === null ||
      check.runId === null ||
      !logs.get(check.id)?.lines.some((l) => l.includes('##[group]Run echo "Dependency failed: '))
    )
      continue;
    try {
      check.steps = await fetchJobSteps({
        ...opts,
        jobId: check.id,
        runId: check.runId,
        sha: check.headSha,
        name: check.name,
      });
    } catch {
      warnings.push(`job ${check.id}: dependency step evidence unavailable; treating summary as an unknown failure`);
    }
  }
  const original = explainChecks(reading.checks, logs, config.ci);
  const explanations = [...original];
  const reruns: {
    runId: number | null;
    status: "requested" | "refused" | "uncertain";
    reason: string;
    tickets: string[];
  }[] = [];
  if (args.options.rerun) {
    // Put actionable unknown failures before flakes when the request is refused.
    explanations.sort(
      (a, b) =>
        Number(["known", "runner", "dependent"].includes(a.class)) -
        Number(["known", "runner", "dependent"].includes(b.class)),
    );
    const groups = new Map<number, Explanation[]>();
    for (const id of reading.runIds) groups.set(id, []);
    for (const [i, check] of reading.checks.entries()) {
      if (check.superseded) continue;
      const explanation = original[i];
      if (!explanation) continue;
      if (check.app !== "github-actions" || check.runId === null) {
        reruns.push({
          runId: null,
          status: "refused",
          reason: `${check.name}: external check or no workflow run; cannot rerun`,
          tickets: [],
        });
      } else {
        const group = groups.get(check.runId) ?? [];
        group.push(explanation);
        groups.set(check.runId, group);
      }
    }
    for (const [runId, failures] of groups) {
      const refuse = (reason: string) => reruns.push({ runId, status: "refused", reason, tickets: [] });
      let current: Awaited<ReturnType<typeof fetchWorkflowRun>>;
      try {
        current = await fetchWorkflowRun({ ...opts, runId });
      } catch {
        refuse("attempt unavailable; cannot establish that this is the first attempt");
        continue;
      }
      // Green first-attempt workflows do not participate in the rerun request.
      if (!failures.length && current.attempt === 1 && current.status === "completed") continue;
      const decision = rerunDecision(failures, current.attempt);
      if (!decision.allowed) {
        refuse(decision.reason);
        continue;
      }
      // Partial pagination, expired/truncated logs and annotations cannot prove every failure known.
      if (warnings.length) {
        refuse("CI evidence is incomplete or unavailable; cannot establish that every failure is known");
        continue;
      }
      if (current.status !== "completed") {
        refuse(
          `workflow is ${current.status ?? "unavailable"}, attempt ${current.attempt}; only completed runs can be rerun`,
        );
        continue;
      }
      // A workflow may have finished another failing job while its first logs were read.
      // Confirm the diagnosed failure set only after the run is known to be complete.
      try {
        const fresh = await fetchFailedChecks({ ...opts, sha: reading.sha });
        const identity = (checks: typeof reading.checks) =>
          JSON.stringify(
            checks
              .filter((c) => c.app === "github-actions" && c.runId === runId)
              .map((c) => [c.id, c.name, c.conclusion, c.headSha, c.superseded ?? false])
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          );
        if (fresh.warnings.length || identity(fresh.checks) !== identity(reading.checks)) {
          refuse("failing checks changed or reading is incomplete; diagnose this run again");
          continue;
        }
      } catch {
        refuse("fresh failure reading unavailable; cannot establish that every failure is known");
        continue;
      }
      if (!io.exec) {
        refuse("gh execution is unavailable");
        continue;
      }
      try {
        const result = await io.exec(
          "gh",
          ["run", "rerun", String(runId), "--failed", "--repo", config.github.repository],
          { cwd: io.cwd },
        );
        reruns.push({
          runId,
          status: result.code === 0 && !result.timedOut ? "requested" : "uncertain",
          reason:
            result.code === 0 && !result.timedOut
              ? "Rerun requested for failed jobs"
              : "rerun outcome uncertain; inspect GitHub before doing anything else; no automatic retry",
          tickets: decision.tickets,
        });
      } catch {
        reruns.push({
          runId,
          status: "uncertain",
          reason: "rerun outcome uncertain; inspect GitHub before doing anything else; no automatic retry",
          tickets: decision.tickets,
        });
      }
    }
    if (!reruns.length)
      reruns.push({ runId: null, status: "refused", reason: "No failing checks to rerun", tickets: [] });
  }
  if (args.json)
    io.stdout(
      `${JSON.stringify({ sha: reading.sha, explanations, warnings, ...(args.options.rerun ? { reruns } : {}) }, null, 2)}\n`,
    );
  else {
    io.stdout(renderCiWhy(reading.sha, explanations));
    for (const r of reruns)
      io.stdout(
        `\n${r.runId === null ? "Rerun" : `Run ${r.runId}`}: ${r.status === "refused" ? "refused: " : ""}${r.reason}${r.tickets.length ? ` (known flakes: ${r.tickets.join(", ")})` : ""}\n`,
      );
    for (const w of warnings) io.stderr(`armada: warning: ${w}\n`);
  }
  return reruns.some((r) => r.status !== "requested") ? 1 : 0;
}
