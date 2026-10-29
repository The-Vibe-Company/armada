import type { GithubPullRequest, PullRequest } from "@armada/daemon/events";

type Ci = PullRequest["ci"];
interface Run {
  databaseId: number | null;
  runNumber: number;
  runAttempt: number;
  workflow: { id: string };
}
interface Suite {
  status?: string;
  conclusion?: string | null;
  commit: { oid: string };
  workflowRun: Run | null;
}
type Context =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null; checkSuite?: Suite | null }
  | { __typename: "StatusContext"; context: string; state: string };
export interface RawPull {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  commits: {
    nodes: {
      commit: {
        oid: string;
        checkSuites: { nodes: Suite[]; pageInfo: { hasNextPage: boolean } };
        statusCheckRollup: { state: string; contexts: { nodes: Context[]; pageInfo: { hasNextPage: boolean } } } | null;
      };
    }[];
  };
}

// Copied/adapted from packages/core/src/github.ts (V1): checkState, headChecks,
// rollup and ticketIdFromBranch. Keep workflow identity/attempt and pinned-head rules.
function checkState(status: string | undefined, conclusion: string | null | undefined): Ci {
  if (status && status !== "COMPLETED") return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion ?? "")) return "success";
  if (
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"].includes(
      conclusion ?? "",
    )
  )
    return "failure";
  return "pending";
}
function headChecks(contexts: Context[], suites: Suite[], head: string): GithubPullRequest["checks"] {
  const latest = new Map<string, Suite>();
  const workflowRun = (suite: Suite | null | undefined) => (suite?.commit.oid === head ? suite.workflowRun : null);
  for (const suite of [
    ...suites,
    ...contexts.flatMap((c) => (c.__typename === "CheckRun" && c.checkSuite ? [c.checkSuite] : [])),
  ]) {
    const run = workflowRun(suite);
    if (!run) continue;
    const previous = latest.get(run.workflow.id)?.workflowRun;
    if (
      !previous ||
      run.runNumber > previous.runNumber ||
      (run.runNumber === previous.runNumber && run.runAttempt > previous.runAttempt)
    )
      latest.set(run.workflow.id, suite);
  }
  const checks: GithubPullRequest["checks"] = [];
  const represented = new Set<string>();
  for (const c of contexts) {
    if (c.__typename === "StatusContext") {
      checks.push({ name: c.context, state: checkState(undefined, c.state) });
      continue;
    }
    if (c.checkSuite && c.checkSuite.commit.oid !== head) continue;
    const run = workflowRun(c.checkSuite);
    const newestSuite = run && latest.get(run.workflow.id);
    const newest = newestSuite?.workflowRun;
    if (
      run &&
      newest &&
      (run.runNumber < newest.runNumber || (run.runNumber === newest.runNumber && run.runAttempt < newest.runAttempt))
    )
      continue;
    if (run) represented.add(run.workflow.id);
    const canceled = newestSuite?.status === "COMPLETED" && newestSuite.conclusion === "CANCELLED";
    checks.push({
      name: c.name,
      state: canceled ? "failure" : checkState(c.status, c.conclusion),
      ...(run?.databaseId != null ? { runId: run.databaseId, runAttempt: run.runAttempt } : {}),
    });
  }
  for (const [id, suite] of latest) {
    const run = suite.workflowRun;
    if (!run) continue;
    const state = checkState(suite.status, suite.conclusion);
    const problem = checks.some((check) => check.runId === run.databaseId && check.state !== "success");
    if (
      (suite.status === "COMPLETED" && suite.conclusion === "CANCELLED") ||
      (!represented.has(id) && state !== "success") ||
      (suite.status && state !== "success" && !problem)
    )
      checks.push({
        name: `workflow run ${run.databaseId ?? run.runNumber}`,
        state,
        ...(run.databaseId != null ? { runId: run.databaseId, runAttempt: run.runAttempt } : {}),
      });
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name) || (a.runId ?? 0) - (b.runId ?? 0));
}

export function normalize(
  raw: RawPull,
  repository: string,
  tickets: ReadonlySet<string>,
  token: string,
): GithubPullRequest {
  // Fail closed on malformed/missing facts. Exceptions are sanitized at the reader boundary.
  if (
    !Number.isSafeInteger(raw.number) ||
    raw.number < 1 ||
    typeof raw.title !== "string" ||
    typeof raw.url !== "string" ||
    !["OPEN", "MERGED", "CLOSED"].includes(raw.state) ||
    typeof raw.isDraft !== "boolean" ||
    !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(raw.mergeable) ||
    typeof raw.mergeStateStatus !== "string" ||
    typeof raw.headRefName !== "string" ||
    !raw.headRefOid ||
    ![null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(raw.reviewDecision)
  )
    throw new Error("Invalid pull request");
  const commit = raw.commits.nodes[0]?.commit;
  if (!commit || commit.oid !== raw.headRefOid || typeof commit.checkSuites.pageInfo.hasNextPage !== "boolean")
    throw new Error("Missing pinned commit");
  const status = commit.statusCheckRollup;
  if (status && (typeof status.contexts.pageInfo.hasNextPage !== "boolean" || typeof status.state !== "string"))
    throw new Error("Invalid checks");
  const clean = (s: string) => s.replaceAll(token, "[redacted]");
  const checks = headChecks(status?.contexts.nodes ?? [], commit.checkSuites.nodes, raw.headRefOid).map((check) => ({
    ...check,
    name: clean(check.name),
  }));
  const complete = !commit.checkSuites.pageInfo.hasNextPage && !status?.contexts.pageInfo.hasNextPage;
  let ci: Ci = !checks.length
    ? "none"
    : checks.some((c) => c.state === "failure")
      ? "failure"
      : checks.some((c) => c.state === "pending")
        ? "pending"
        : "success";
  if (!complete) ci = ci === "failure" || status?.state === "FAILURE" ? "failure" : "pending";
  let ticket = "";
  for (const m of raw.headRefName.matchAll(/(?:^|[/_-])([a-z][a-z0-9]*-\d+)(?=[-_/]|$)/gi)) {
    const id = m[1]?.toUpperCase();
    if (id && tickets.has(id)) {
      ticket = id;
      break;
    }
  }
  return {
    repository,
    number: raw.number,
    ticket: clean(ticket),
    title: clean(raw.title),
    url: clean(raw.url),
    state: raw.state === "OPEN" ? "open" : raw.state === "MERGED" ? "merged" : "closed",
    head: clean(raw.headRefOid),
    headRef: clean(raw.headRefName),
    draft: raw.isDraft,
    conflicting: raw.mergeable === "CONFLICTING" || raw.mergeStateStatus === "DIRTY",
    review: (raw.reviewDecision?.toLowerCase() as GithubPullRequest["review"]) ?? "none",
    ci,
    checks,
    checksComplete: complete,
  };
}
