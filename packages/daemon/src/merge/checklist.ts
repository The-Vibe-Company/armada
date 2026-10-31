import type { JsonObject } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import type { ProjectTables } from "../fold.ts";
import { type MergeFailureCode, refusalLine, refuse } from "./refusal.ts";

const id = Type.String({ minLength: 1 });
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const checkState = Type.Union([
  Type.Literal("none"),
  Type.Literal("pending"),
  Type.Literal("success"),
  Type.Literal("failure"),
]);
export const mergeEvidenceSchema = object({
  head: sha,
  base: sha,
  observedAt: Type.String(),
  checksComplete: Type.Boolean(),
  title: Type.String(),
  draft: Type.Boolean(),
  mergeState: Type.String(),
  checks: Type.Array(object({ name: id, state: checkState })),
  requiredChecks: Type.Array(id),
  reviewThreads: object({
    complete: Type.Boolean(),
    total: Type.Integer({ minimum: 0 }),
    read: Type.Integer({ minimum: 0 }),
    unresolved: Type.Integer({ minimum: 0 }),
  }),
  acceptance: object({
    state: Type.Union([Type.Literal("passed"), Type.Literal("not-required"), Type.Literal("unknown")]),
    head: sha,
  }),
  ownerApproval: object({
    state: Type.Union([
      Type.Literal("approved"),
      Type.Literal("not-required"),
      Type.Literal("pending"),
      Type.Literal("unknown"),
    ]),
    head: sha,
  }),
  baseTest: object({ state: Type.Union([Type.Literal("passed"), Type.Literal("unknown")]), head: sha, base: sha }),
});
/** Adapter facts must explicitly prove complete enumeration and name the heads/base they concern. */
export type MergeEvidence = Static<typeof mergeEvidenceSchema>;

/** Copied from V1 core/src/merge.ts assess/mergeProblems. Never import V1 I/O or rules. */
export function checkMerge(
  tables: ProjectTables,
  number: number,
  project: string,
  evidence: MergeEvidence | null,
): { result: JsonObject } {
  const no = (code: string, message: string, next: string) => ({ result: refuse(code, message, next) });
  const pr = tables.pullRequests.find((p) => p.number === number);
  if (!pr) return no("no_pr", `PR #${number} is not open in ${project}`, "fleet.status");
  const session = tables.sessions.find((s) => s.ticket === pr.ticket);
  const handBack = [...tables.inbox]
    .reverse()
    .find(
      (i) =>
        i.ticket === pr.ticket &&
        i.kind === "hand-back" &&
        /^Agent status: ready-to-merge — (?!note:|answer:|acceptance:)/m.test(i.body) &&
        i.actor !== "coordinator",
    );
  const problems: string[] = [];
  const causes: { code: MergeFailureCode; reason: string; next: string }[] = [];
  const cause = (code: MergeFailureCode, reason: string, next: string) => causes.push({ code, reason, next });
  const worker = "ask the worker (worker.message) to fix and hand back";
  // Copied from core/src/merge.ts assess / mergeProblems. Unknown evidence always refuses.
  if (session?.phase !== "ready-to-merge")
    problems.push(
      `${pr.ticket} has not been handed back: its agent phase is ${session?.phase ?? "not set"}, not ready-to-merge`,
    );
  if (!handBack) problems.push(`${pr.ticket} has no "Agent status: ready-to-merge" comment carrying the head SHA`);
  else {
    const sha = handBack.body.match(/\bhead ([0-9a-f]+)\b/i)?.[1]?.toLowerCase();
    const number = handBack.body.match(/\bPR #(\d+)/i)?.[1];
    if (number && Number(number) !== pr.number)
      problems.push(`the hand-back on ${pr.ticket} names PR #${number}, not #${pr.number}`);
    if (!sha) problems.push(`the hand-back on ${pr.ticket} carries no head SHA`);
    else if (!/^[0-9a-f]{40}$/.test(sha))
      problems.push(
        `the handed-back SHA ${sha ?? "missing"} is not a full 40-character SHA; ask the worker to report ready-to-merge again`,
      );
    else if (sha !== pr.head)
      problems.push(
        `the head of #${pr.number} is ${pr.head}, not the handed-back ${sha}: it moved after the hand-back; ask the worker to report again`,
      );
  }
  if (pr.state !== "open") problems.push(`#${pr.number} is ${pr.state}, not open`);
  if (pr.conflicting) problems.push(`#${pr.number} conflicts with its base; ask the worker to merge it in or rebase`);

  for (const hold of tables.holds) problems.push(`merge hold ${hold.id}: ${refusalLine(hold.reason)}`);
  if (tables.holds.length)
    cause(
      "hold_open",
      `Merge holds: ${tables.holds.map((h) => `${h.id}: ${refusalLine(h.reason)}`).join("; ")}`,
      `hold.clear ${tables.holds.map((h) => h.id).join(", ")} with recovery evidence, then merge.run`,
    );
  if (pr.conflicting || evidence?.mergeState === "DIRTY")
    cause("base_conflict", `#${pr.number} conflicts with its base`, worker);
  // Copied from core/src/validations.ts lastValidation: a newer submission replaces the earlier decision.
  const validation = tables.validations.filter((v) => v.ticket === pr.ticket && v.session === session?.session).at(-1);
  if (validation && validation.decision?.decision !== "approved")
    problems.push("owner validation is pending or changes were requested");
  if (!evidence) problems.push("merge review, acceptance, approval and base-test evidence is unavailable");
  else {
    if (evidence.head !== pr.head) {
      problems.push("merge evidence is for a different head");
      cause("head_moved", `Head moved from ${pr.head.slice(0, 7)} to ${evidence.head.slice(0, 7)}`, worker);
    }
    const handedHead = handBack?.body.match(/\bhead ([0-9a-f]{40})\b/i)?.[1]?.toLowerCase();
    if (handedHead && handedHead !== pr.head)
      cause("head_moved", `The hand-back no longer matches head ${pr.head.slice(0, 7)}`, worker);
    if (evidence.draft) problems.push(`#${pr.number} is a draft`);
    if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./,-]+\))?!?: \S/.test(evidence.title))
      problems.push(`the title "${evidence.title}" is not in Commitizen format, e.g. "feat(cli): add a command"`);
    if (!["CLEAN", "HAS_HOOKS"].includes(evidence.mergeState))
      problems.push(`GitHub reports #${pr.number} as ${evidence.mergeState}, not CLEAN`);
    const red = [...new Set(evidence.checks.filter((c) => c.state === "failure").map((c) => c.name))];
    if (red.length) cause("checks_red", `Red: ${red.join(", ")} on ${evidence.head.slice(0, 7)}`, worker);
    const pending = [
      ...new Set([
        ...evidence.requiredChecks.filter((name) => !evidence.checks.some((c) => c.name === name)),
        ...evidence.checks.filter((c) => c.state === "pending" || c.state === "none").map((c) => c.name),
      ]),
    ];
    if (pending.length || !evidence.checks.length || !evidence.checksComplete)
      cause(
        "checks_pending",
        `Checks pending on ${evidence.head.slice(0, 7)}: ${pending.join(", ") || "complete CI evidence"}`,
        !evidence.checks.length
          ? "rules.set gates requiredChecks if required checks are missing; merge.run again after checks report green"
          : "merge.run again after all checks report green",
      );
    const on = `on head ${evidence.head.slice(0, 7)}: `;
    for (const name of evidence.requiredChecks) {
      const runs = evidence.checks.filter((c) => c.name === name);
      if (!runs.length) problems.push(`${on}required check "${name}" has not reported on the head yet`);
      else
        for (const check of runs)
          if (check.state !== "success") problems.push(`${on}required check "${name}" is ${check.state}`);
    }
    if (!evidence.checks.length)
      problems.push(
        `${on}no CI check has reported on the head yet (configure missing check names with rules.set gates requiredChecks)`,
      );
    for (const check of evidence.checks)
      if (!evidence.requiredChecks.includes(check.name) && check.state !== "success")
        problems.push(`${on}check "${check.name}" is ${check.state}`);
    if (!evidence.checksComplete) problems.push("check enumeration is incomplete");
    const { total, read, unresolved, complete } = evidence.reviewThreads;
    if (!complete || total !== read || unresolved > read)
      problems.push("review-thread evidence is incomplete or inconsistent");
    if (!complete || total !== read || unresolved > 0)
      cause(
        "review_threads_open",
        `#${pr.number}: ${unresolved} unresolved review threads; read ${read} of ${total}${complete ? "" : " (incomplete)"}`,
        "worker.message to resolve and confirm all review threads, then merge.run",
      );
    if (unresolved)
      problems.push(`#${pr.number} has ${unresolved} unresolved review thread${unresolved > 1 ? "s" : ""}`);
    else if (total > read)
      problems.push(`#${pr.number} has more than ${read} review threads; check they are resolved by hand`);
    if (!["passed", "not-required"].includes(evidence.acceptance.state))
      problems.push("acceptance evidence is unavailable");
    if (!["approved", "not-required"].includes(evidence.ownerApproval.state))
      problems.push("owner merge approval is pending or unavailable");
    if (evidence.baseTest.state !== "passed") problems.push("fresh-main test evidence is unavailable");
    if (
      evidence.acceptance.head !== pr.head ||
      evidence.ownerApproval.head !== pr.head ||
      evidence.baseTest.head !== pr.head ||
      evidence.baseTest.base !== evidence.base
    )
      problems.push("acceptance, approval or base-test evidence is for an earlier head/base");
  }
  // Prefer the actionable safety gate; keep every prerequisite in problems.
  const primary = causes[0];
  const cleanProblems = problems.map((p) => refusalLine(p));
  return {
    result: problems.length
      ? refuse(
          primary?.code ?? "merge_refused",
          primary?.reason ?? cleanProblems.join("; "),
          primary?.next ?? "worker.message to fix the listed prerequisites and hand back, then merge.check",
          {
            problems: cleanProblems,
          },
        )
      : { ok: true, pr: pr.number, head: pr.head, ticket: pr.ticket },
  };
}
