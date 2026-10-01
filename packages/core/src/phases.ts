// The worker phase machine and the hand-back gate. Pure: the commands read
// the ticket and the pull request, these rules decide.
import { type ArmadaConfig, type PlanPolicy, routingLabelKey } from "./config.ts";
import type { CiState, LabelPhase, PullRequest } from "./types.ts";
import { LABEL_PHASES } from "./types.ts";

/**
 * Where a worker may go from each phase. Any phase may also move to
 * `blocked`, and reporting the current phase again is a status update.
 */
export const TRANSITIONS: Record<LabelPhase, readonly LabelPhase[]> = {
  planning: ["awaiting-approval", "implementing"],
  // A rejected plan goes back to planning.
  "awaiting-approval": ["planning", "implementing"],
  implementing: ["shipping"],
  // Review or CI can send the work back to implementation.
  shipping: ["implementing", "ready-to-merge"],
  // The coordinator may ask to bring the default branch in, or for a fix, after the hand-back.
  "ready-to-merge": ["shipping"],
  // Unblocked work resumes where it stood; ready-to-merge still passes the gate.
  blocked: ["planning", "awaiting-approval", "implementing", "shipping", "ready-to-merge"],
};

export const isLabelPhase = (v: string): v is LabelPhase => (LABEL_PHASES as readonly string[]).includes(v);

/** Null when the move is allowed, else the reason it is refused. */
export function transitionProblem(from: LabelPhase | null, to: LabelPhase): string | null {
  if (from === null) return "the ticket has no agent phase: no worker has claimed it";
  if (from === to || to === "blocked" || TRANSITIONS[from].includes(to)) return null;
  const allowed = [...TRANSITIONS[from], "blocked", `${from} (status update)`].join(", ");
  return `cannot go from ${from} to ${to}; from ${from} a worker may report: ${allowed}`;
}

/** Whether a ticket's plan waits for approval, and why: `[policy] plans`, unless a label of the ticket overrides it. */
export function planRule(config: ArmadaConfig, labels: string[]): { rule: PlanPolicy; why: string } {
  const { plans, preApprovedLabel, approvalLabel } = config.policy;
  const has = (name: string) => labels.some((l) => routingLabelKey(l) === routingLabelKey(name));
  // Asking for approval is the safer rule: it wins when a ticket carries both labels.
  if (has(approvalLabel)) return { rule: "approve", why: `the ticket's label ${approvalLabel}` };
  if (has(preApprovedLabel)) return { rule: "pre-approved", why: `the ticket's label ${preApprovedLabel}` };
  return { rule: plans, why: `armada.toml [policy] plans = "${plans}"` };
}

export const FULL_SHA = /^[0-9a-f]{40}$/;

export interface HandBackInput {
  /** The pull request as read from the forge, or null when none is linked. */
  pr: PullRequest | null;
  /** owner/name the project lives in. */
  repository: string;
  /** Head SHA the worker hands back. */
  sha: string | null;
  /** `[gates] required_checks`; empty means every reported check. */
  requiredChecks: readonly string[];
}

/**
 * Every reason a hand-back is refused; empty when it is acceptable. A
 * hand-back names an open pull request of the project, the full head SHA
 * that pull request points at, and green required checks on that head.
 */
export function handBackProblems({ pr, repository, sha, requiredChecks }: HandBackInput): string[] {
  const problems: string[] = [];
  if (!sha) problems.push("--sha is required: the full 40-character head SHA of the pull request");
  else if (!FULL_SHA.test(sha))
    problems.push(`--sha must be the full 40-character commit SHA, got "${sha}" (${sha.length} characters)`);
  if (!pr) {
    problems.push("no pull request is linked to the ticket; pass --pr <number or URL>");
    return problems;
  }
  if (pr.repo.toLowerCase() !== repository.toLowerCase())
    problems.push(`pull request #${pr.number} is in ${pr.repo}, not in the project repository ${repository}`);
  if (pr.state && pr.state !== "open") problems.push(`pull request #${pr.number} is ${pr.state}, not open`);
  if (pr.draft) problems.push(`pull request #${pr.number} is a draft; mark it ready for review`);
  if (pr.mergeable === "CONFLICTING")
    problems.push(
      `pull request #${pr.number} conflicts with its base; bring the base branch in (rebase, or merge it into your branch)`,
    );
  if (!pr.headSha) problems.push(`the head of pull request #${pr.number} could not be read from GitHub`);
  else if (sha && FULL_SHA.test(sha) && pr.headSha !== sha)
    problems.push(`${sha} is not the head of pull request #${pr.number} (head is ${pr.headSha}); push, then report`);
  problems.push(...checkProblems(pr.checks ?? [], requiredChecks));
  return problems;
}

/**
 * Why the checks on a head are not green enough to hand back or merge: every
 * required check reported and green on every run, or, with none declared, at
 * least one check and all of them green.
 */
export function checkProblems(checks: readonly { name: string; state: CiState }[], requiredChecks: readonly string[]) {
  const problems: string[] = [];
  if (requiredChecks.length) {
    for (const name of requiredChecks) {
      // A check can report more than once on a head (push and pull_request): every run must be green.
      const runs = checks.filter((c) => c.name === name);
      const bad = runs.find((c) => c.state !== "success");
      if (!runs.length) problems.push(`required check "${name}" has not reported on the head yet`);
      else if (bad) problems.push(`required check "${name}" is ${bad.state}`);
    }
  } else if (!checks.length) {
    problems.push("no CI check has reported on the head yet (or set [gates] required_checks in armada.toml)");
  } else {
    for (const c of checks) if (c.state !== "success") problems.push(`check "${c.name}" is ${c.state}`);
  }
  return problems;
}
