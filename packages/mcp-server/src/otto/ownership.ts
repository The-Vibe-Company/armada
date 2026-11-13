import type { OttoFact, OttoResource, OttoTruth } from "@armada/core";
import { type FleetSandbox, fresh, repositoryOf } from "./fleet.ts";

/** Only exact-head positive failure evidence establishes needs-work. Pending is UNKNOWN. */
export function needsWork(pr: OttoFact, facts: OttoFact[], now: Date): OttoTruth {
  const head = pr.evidence.head as { sha?: string } | undefined;
  if (!head?.sha) return "unknown";
  const evidence = facts.filter(
    (f) =>
      f.subject === pr.subject &&
      (f.kind === "pr.needs_work" || f.kind.startsWith("pr.work.")) &&
      f.evidence.headSha === head.sha &&
      fresh(f.observed_at, now),
  );
  if (evidence.some((f) => f.value === "true")) return "true";
  return evidence.some((f) => f.kind === "pr.needs_work" && f.value === "false" && f.completeness === "complete") ||
    ["pr.work.conflict", "pr.work.required_check", "pr.work.queue"].every((kind) =>
      evidence.some((f) => f.kind === kind && f.value === "false" && f.completeness === "complete"),
    )
    ? "false"
    : "unknown";
}
export interface OwnershipFact extends OttoFact {
  head_first_seen_at?: string;
}
export function ownership(
  pr: OwnershipFact,
  sandboxes: FleetSandbox[],
  repository: string,
  restricted: boolean,
  now: Date,
  history: OttoFact[] = [],
): Pick<OttoResource, "owner" | "reason"> {
  const e = pr.evidence,
    head = e.head as { ref?: string; repo?: string; sha?: string } | undefined;
  if (!fresh(pr.observed_at, now) || !head?.sha || !head.ref || !head.repo)
    return { owner: { state: "unknown", userId: null }, reason: "pr_observation_stale_or_missing" };
  const candidates = sandboxes.filter(
    (s) => repositoryOf(s.resource_project?.url) === repository && head.repo === repository && s.branch === head.ref,
  );
  const reported = sandboxes.filter((s) => {
    const report = s.task_outcome;
    return (
      report?.state === "ready" &&
      !!s.task_prompt_id &&
      report.headSha === head.sha &&
      (report.prUrl === `https://github.com/${repository}/pull/${e.number}` ||
        (repositoryOf(s.resource_project?.url) === repository && report.prNumber === e.number))
    );
  });
  const matches = [...new Map([...candidates, ...reported].map((s) => [s.id, s])).values()];
  if (matches.length > 1)
    return {
      owner: { state: "unknown", userId: null, candidateSandboxIds: matches.map((s) => s.id) },
      reason: "ambiguous_owners",
    };
  const s = matches[0];
  if (s) {
    if (!fresh(s.last_observed_at, now) && s.activity !== "not_live")
      return {
        owner: { state: "unknown", userId: null, candidateSandboxIds: [s.id] },
        reason: "owner_observation_stale",
      };
    const movedAt = pr.head_first_seen_at;
    const moved =
      !!movedAt &&
      s.runningWindows.some((w) => {
        const current = Date.parse(movedAt);
        return (
          w.branch === head.ref &&
          w.start <= current &&
          (w.end === null ? s.activity === "live" : current <= w.end) &&
          history.some((f) => {
            const prior = (f.evidence.head as { sha?: string } | undefined)?.sha;
            return (
              f.subject === pr.subject &&
              f.kind === "pr.open" &&
              typeof prior === "string" &&
              prior !== head.sha &&
              Date.parse(f.observed_at) >= w.start &&
              f.observed_at < movedAt
            );
          })
        );
      });
    const confirmed = reported.includes(s) || moved;
    if (
      s.activity === "not_live" &&
      !restricted &&
      !sandboxes.some((other) => other !== s && (!other.branchComplete || other.activity === "unknown"))
    )
      return {
        owner: { state: "orphan", userId: s.owner_id, sandboxId: s.id, confirmation: "confirmed" },
        reason: "pr_without_live_owner",
      };
    return {
      owner: {
        state: confirmed ? "owned" : "candidate",
        userId: s.owner_id,
        sandboxId: s.id,
        confirmation: confirmed ? "confirmed" : "candidate",
      },
      reason: confirmed
        ? reported.includes(s)
          ? "reported_exact_head"
          : "head_moved_during_running_turn"
        : "repository_branch_candidate",
    };
  }
  // Without every visible sandbox binding, an unmatched PR is UNKNOWN, never orphan by guess.
  if (
    restricted ||
    sandboxes.some(
      (s) => s.activity !== "not_live" && (!s.resource_project || !s.branchComplete || s.activity === "unknown"),
    )
  )
    return { owner: { state: "unknown", userId: null }, reason: "ownership_evidence_incomplete" };
  return { owner: { state: "orphan", userId: null }, reason: "pr_without_live_owner" };
}
