import type { OttoResource, OttoTask } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import { fresh, issueFromBranch, readFleet, repositoryOf } from "./fleet.ts";
import type { OttoScope } from "./observation.ts";
import { needsWork, ownership } from "./ownership.ts";
import { type OttoSnapshot, readOttoSnapshot } from "./snapshot.ts";

/** No prompt execution, provider queries or task commands. */
export async function readOttoModel(
  sql: Sql,
  scope: OttoScope,
  caller: Caller,
  now: Date,
  key?: string,
  supplied?: OttoSnapshot,
) {
  const snapshot = supplied ?? (await readOttoSnapshot(sql, scope, caller, now.toISOString().slice(0, 10), key));
  const facts = snapshot.facts.map((f) => ({
    ...f,
    observed_at: new Date(f.observed_at).toISOString(),
    ...(f.head_first_seen_at ? { head_first_seen_at: new Date(f.head_first_seen_at).toISOString() } : {}),
  }));
  const inventory = facts.find((f) => f.kind === "repository.open_prs");
  const inventoryFresh = inventory && fresh(inventory.observed_at, now);
  const completeness =
    !snapshot.capped && inventoryFresh && inventory.completeness === "complete" ? "complete" : "unknown";
  const listed = new Set(Array.isArray(inventory?.evidence.numbers) ? inventory.evidence.numbers : []);
  const latest = [...new Map([...facts].reverse().map((f) => [`${f.subject}:${f.kind}`, f])).values()];
  const prs = latest.filter(
    (f) =>
      f.kind === "pr.open" &&
      f.value === "true" &&
      !(
        inventory?.completeness === "complete" &&
        inventory.observed_at > f.observed_at &&
        !listed.has(f.evidence.number)
      ),
  );
  const fleet = await readFleet(sql, scope, caller, now, key, snapshot);
  const sandboxes = fleet.sandboxes;
  const resources: OttoResource[] = [],
    tasks = new Map<number, OttoTask>();
  for (const pr of prs) {
    const e = pr.evidence,
      head = e.head as { ref?: string; repo?: string; sha?: string } | undefined;
    const match = head?.repo === scope.repository ? /^codex\/([1-9]\d*)-/.exec(head.ref ?? "") : null;
    const issue = match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
    const issueFact = facts.find((f) => f.kind === "issue" && f.evidence.number === issue);
    if (issue !== null) {
      const task: OttoTask = {
        issueNumber: issue,
        title: String(issueFact?.evidence.title ?? `Issue #${issue}`),
        state: issueFact?.value === "true" ? "open" : "unknown",
        factId: issueFact?.id ?? pr.id,
      };
      tasks.set(issue, task);
    }
    const attribution = ownership(pr, sandboxes, scope.repository, fleet.restricted, now, facts);
    const work = needsWork(pr, facts, now);
    const owner = sandboxes.find((s) => s.id === attribution.owner.sandboxId);
    resources.push({
      kind: "pr",
      externalId: String(e.number),
      taskIssue: issue,
      ...attribution,
      reason:
        attribution.owner.state === "owned" && owner?.activity === "idle" && work === "true"
          ? "idle_owner_needs_work"
          : attribution.reason,
      observedAt: pr.observed_at,
      needsWork: work,
      ...(owner
        ? { activity: { state: owner.activity, observedAt: owner.activityObservedAt, since: owner.activityAt } }
        : {}),
      evidence: {
        factId: pr.id,
        head: head ?? null,
        title: e.title,
        ownerSource: attribution.reason,
        workFacts: facts
          .filter(
            (f) =>
              f.kind.startsWith("pr.work.") &&
              f.subject === pr.subject &&
              f.evidence.headSha === head?.sha &&
              fresh(f.observed_at, now),
          )
          .map((f) => ({ id: f.id, kind: f.kind, value: f.value, observedAt: f.observed_at })),
      },
    });
  }
  for (const s of sandboxes) {
    const repo = repositoryOf(s.resource_project?.url);
    if (repo && repo !== scope.repository) continue;
    const linkedPrs = resources.filter(
      (r) => r.kind === "pr" && (r.owner.sandboxId === s.id || r.owner.candidateSandboxIds?.includes(s.id)),
    );
    const linkedTasks = [
      ...new Set(linkedPrs.map((r) => r.taskIssue).filter((issue): issue is number => issue !== null)),
    ];
    const task =
      linkedTasks.length > 1
        ? null
        : (linkedTasks[0] ?? (repo === scope.repository ? issueFromBranch(s.branch) : null));
    if (task !== null && !tasks.has(task)) {
      const observed = facts.find((f) => f.kind === "issue" && f.evidence.number === task);
      tasks.set(task, {
        issueNumber: task,
        title: String(observed?.evidence.title ?? `Issue #${task}`),
        state: observed?.value === "true" ? "open" : "unknown",
        factId: observed?.id ?? null,
      });
    }
    const linked = linkedPrs.length > 0;
    const orphan =
      repo === scope.repository &&
      s.branchComplete &&
      task === null &&
      !linked &&
      completeness === "complete" &&
      ["live", "idle"].includes(s.activity);
    resources.push({
      kind: "sandbox",
      externalId: s.id,
      taskIssue: task,
      owner: { state: "owned", userId: s.owner_id },
      reason: orphan
        ? "live_sandbox_without_task_or_pr"
        : task !== null || linked
          ? "sandbox_task_link"
          : "sandbox_task_link_unknown",
      observedAt: s.last_observed_at,
      activity: { state: s.activity, observedAt: s.activityObservedAt, since: s.activityAt },
      evidence: {
        status: s.status,
        linkedTaskIssues: linkedTasks,
        launchBranch: s.resource_project?.branch ?? null,
        branch: s.branch,
        branchIsCurrent: false,
      },
    });
  }
  return {
    resources,
    tasks: [...tasks.values()].sort((a, b) => a.issueNumber - b.issueNumber),
    completeness,
    observedAt: inventory?.observed_at ?? null,
    orphanCompleteness:
      completeness === "complete" &&
      !snapshot.historyCapped &&
      !fleet.restricted &&
      resources.every(
        (r) =>
          !["unknown", "candidate"].includes(r.owner.state) &&
          r.activity?.state !== "unknown" &&
          !(r.kind === "pr" && r.activity?.state === "idle" && r.needsWork === "unknown") &&
          r.reason !== "sandbox_task_link_unknown",
      )
        ? "complete"
        : "unknown",
    fleetCompleteness: snapshot.capped ? "partial" : "complete",
    ownershipCompleteness:
      !fleet.restricted &&
      resources
        .filter((r) => r.kind === "pr")
        .every((r) => !["unknown", "candidate"].includes(r.owner.state) && r.activity?.state !== "unknown")
        ? "complete"
        : "unknown",
  };
}
