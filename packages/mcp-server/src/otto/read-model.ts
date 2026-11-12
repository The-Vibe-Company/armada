import type { OttoFact, OttoResource, OttoTask } from "@armada/core";
import type { Sql } from "@armada/core/server";
import type { Caller } from "../caller.ts";
import type { OttoScope } from "./observation.ts";

interface Sandbox {
  id: string;
  owner_id: string;
  access_owner_id: string | null;
  visibility: string;
  status: string;
  last_observed_at: string | null;
  resource_project: { url: string; branch: string } | null;
}
/** No prompt parsing, exec, provider queries, declarations or task mutation. */
export async function readOttoModel(sql: Sql, scope: OttoScope, caller: Caller, now: Date) {
  const params = [scope.orgId, scope.repository];
  const facts = (
    await sql.query<OttoFact>(
      `select distinct on(subject,kind) * from public.otto_facts where org_id=$1 and repository=$2 order by subject,kind,observed_at desc,id desc`,
      params,
    )
  ).rows;
  const inventory = facts.find((f) => f.kind === "repository.open_prs");
  const fresh = inventory && now.getTime() - new Date(inventory.observed_at).getTime() < 600_000;
  const completeness = fresh && inventory.completeness === "complete" ? "complete" : "unknown";
  const listed = new Set(Array.isArray(inventory?.evidence.numbers) ? inventory.evidence.numbers : []);
  const prs = facts.filter(
    (f) =>
      f.kind === "pr.open" &&
      f.value === "true" &&
      !(
        inventory?.completeness === "complete" &&
        inventory.observed_at > f.observed_at &&
        !listed.has(f.evidence.number)
      ),
  );
  // Privileged SQL must carry visibility itself; hidden sandboxes never become candidates.
  const sandboxes = (
    await sql.query<Sandbox>(
      `select id,owner_id,access_owner_id,visibility,status,last_observed_at,resource_project from public.sandboxes
 where org_id=$1 and deleted_at is null and status in ('ready','running','starting')
 and (visibility='org' or access_owner_id=$2)`,
      [scope.orgId, caller.userId],
    )
  ).rows;
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
      await sql.query(
        `insert into public.otto_tasks(org_id,repository,issue_number,title,state,fact_id,observed_at) values($1,$2,$3,$4,$5,$6,$7)
       on conflict(org_id,repository,issue_number) do update set title=excluded.title,state=excluded.state,fact_id=excluded.fact_id,observed_at=excluded.observed_at`,
        [...params, issue, task.title, task.state, task.factId, pr.observed_at],
      );
    }
    // Launch branch and agent-declared task_outcome are not proof of current responsibility.
    resources.push({
      kind: "pr",
      externalId: String(e.number),
      taskIssue: issue,
      owner: { state: "unknown", userId: null },
      reason: "current_worker_branch_not_observed",
      observedAt: pr.observed_at,
      evidence: { factId: pr.id, head: head ?? null, title: e.title },
    });
  }
  for (const s of sandboxes) {
    const project = s.resource_project;
    if (!project || project.url.replace(/\.git$/, "") !== `https://github.com/${scope.repository}`) continue;
    resources.push({
      kind: "sandbox",
      externalId: s.id,
      taskIssue: null,
      owner: { state: "owned", userId: s.owner_id },
      reason: "armada_user_owner_task_link_unknown",
      observedAt: s.last_observed_at,
      evidence: { status: s.status, launchBranch: project.branch, branchIsCurrent: false },
    });
  }
  for (const r of resources) {
    const s = r.kind === "sandbox" ? sandboxes.find((s) => s.id === r.externalId) : undefined;
    await sql.query(
      `insert into public.otto_resources(org_id,repository,kind,external_id,task_issue,owner_state,owner_id,access_owner_id,reason,observed_at,evidence)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    on conflict(org_id,repository,kind,external_id) do update set task_issue=excluded.task_issue,owner_state=excluded.owner_state,owner_id=excluded.owner_id,access_owner_id=excluded.access_owner_id,reason=excluded.reason,observed_at=excluded.observed_at,evidence=excluded.evidence`,
      [
        ...params,
        r.kind,
        r.externalId,
        r.taskIssue,
        r.owner.state,
        r.owner.userId,
        s?.visibility === "private" ? s.access_owner_id : null,
        r.reason,
        r.observedAt,
        JSON.stringify(r.evidence),
      ],
    );
  }
  return {
    resources,
    tasks: [...tasks.values()].sort((a, b) => a.issueNumber - b.issueNumber),
    completeness,
    observedAt: inventory?.observed_at ?? null,
  };
}
