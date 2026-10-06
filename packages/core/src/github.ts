// GitHub read adapter: one GraphQL call returns the open pull requests and the
// recently closed ones with their CI rollup and mergeability. The rollup's
// check runs need a token with the Checks permission: the dashboard's GitHub
// App installation token has it (THE-851), fine-grained personal tokens do not.
import { MAIN_HISTORY_WINDOW, mainHealth } from "./fleet.ts";
import {
  type Fetch,
  HttpRequestError,
  type HttpRequestOptions,
  HttpStatusError,
  httpRequest,
  retryStatus,
} from "./http.ts";
import type { CiState, ForgeData, Issue, MainCommit, MainHealth, ProgramData, PullRequest } from "./types.ts";

export const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export class GithubError extends Error {
  override name = "GithubError";
}

/** Maps a check run (status + conclusion) or a commit status (state) onto a CI state. */
export function checkState(status: string | null | undefined, conclusion: string | null | undefined): CiState {
  const s = (status ?? "").toUpperCase();
  const c = (conclusion ?? "").toUpperCase();
  if (s && s !== "COMPLETED") return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c)) return "success";
  if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"].includes(c))
    return "failure";
  return "pending";
}

export function rollup(states: CiState[]): CiState {
  if (!states.length) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return "success";
}

/**
 * Ticket identifier named by a branch, e.g. `feature/abc-12-add-login` → ABC-12.
 * Only identifiers present in `known` count, so any team key works and
 * unrelated tokens such as `utf-8` are ignored.
 */
export function ticketIdFromBranch(branch: string, known: ReadonlySet<string>): string | null {
  for (const m of branch.matchAll(/(?:^|[/_-])([a-z][a-z0-9]*-\d+)(?=[-_/]|$)/gi)) {
    const id = m[1]?.toUpperCase();
    if (id && known.has(id)) return id;
  }
  return null;
}

// ------------------------------------------------------------------ raw shapes

type RawContext =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string };

interface RawMainBranch {
  name: string;
  target: {
    history?: {
      nodes: {
        oid: string;
        committedDate: string;
        messageHeadline: string;
        statusCheckRollup: {
          state: string;
          contexts: { nodes: RawContext[]; pageInfo?: { hasNextPage: boolean } };
        } | null;
      }[];
      pageInfo?: { hasNextPage: boolean };
    };
  };
}

function normalizeMain(branch: RawMainBranch | null | undefined): MainCommit[] {
  if (!branch) return [];
  return (branch.target.history?.nodes ?? []).map((c) => ({
    branch: branch.name,
    sha: c.oid,
    at: c.committedDate,
    headline: c.messageHeadline,
    checksComplete: c.statusCheckRollup?.contexts.pageInfo?.hasNextPage !== true,
    ci: c.statusCheckRollup ? checkState("", c.statusCheckRollup.state) : "none",
    checks:
      c.statusCheckRollup?.contexts.nodes.map((context) =>
        context.__typename === "CheckRun"
          ? { name: context.name, state: checkState(context.status, context.conclusion) }
          : { name: context.context, state: checkState("", context.state) },
      ) ?? [],
  }));
}

export interface RawPull {
  additions?: number;
  deletions?: number;
  mergeStateStatus?: string;
  files?: { nodes: { path: string; additions: number; deletions: number }[]; pageInfo: { hasNextPage: boolean } };
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: RawContext[]; pageInfo?: { hasNextPage: boolean } };
        } | null;
      };
    }[];
  };
}

export function normalizePull(raw: RawPull, repo: string): PullRequest {
  const status = raw.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks = status?.contexts.nodes.map((c) =>
    c.__typename === "CheckRun"
      ? { name: c.name, state: checkState(c.status, c.conclusion) }
      : { name: c.context, state: checkState("", c.state) },
  );
  return {
    files: raw.files?.nodes ?? null,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    filesComplete: !!raw.files && !raw.files.pageInfo.hasNextPage,
    checksComplete: !status || status.contexts.pageInfo?.hasNextPage === false,
    mergeability:
      raw.mergeable === "CONFLICTING" || raw.mergeStateStatus === "DIRTY"
        ? "conflicting"
        : raw.mergeStateStatus === "BEHIND"
          ? "behind"
          : raw.mergeable === "MERGEABLE"
            ? "clean"
            : "unknown",
    url: raw.url,
    number: raw.number,
    repo,
    title: raw.title,
    state: raw.state === "OPEN" ? "open" : raw.state === "MERGED" ? "merged" : "closed",
    draft: raw.isDraft,
    ci: status?.contexts.pageInfo?.hasNextPage
      ? checkState("", status.state)
      : checks
        ? rollup(checks.map((c) => c.state))
        : "none",
    checks: checks ?? [],
    mergeable: raw.mergeable,
    headRef: raw.headRefName,
    headSha: raw.headRefOid,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
  };
}

const PULL_FIELDS = /* GraphQL */ `
  fragment P on PullRequest {
    number title url state isDraft mergeable mergeStateStatus headRefName headRefOid createdAt updatedAt mergedAt additions deletions
    files(first: 100) { nodes { path additions deletions } pageInfo { hasNextPage } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage } nodes {
      __typename
      ... on CheckRun { name status conclusion }
      ... on StatusContext { context state }
    } } } } } }
  }`;

const MAIN_FIELDS = /* GraphQL */ `
  defaultBranchRef { name target { ... on Commit {
    history(first: ${MAIN_HISTORY_WINDOW}) { pageInfo { hasNextPage } nodes {
      oid committedDate messageHeadline
      statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } } }
    } }
  } } }`;

const PULLS_QUERY = /* GraphQL */ `${PULL_FIELDS}
  query Pulls($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${MAIN_FIELDS}
      open: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage }
        nodes { ...P }
      }
      closed: pullRequests(states: [MERGED, CLOSED], first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...P } }
    }
  }`;

export interface FetchForgeOptions extends HttpRequestOptions {
  token: string;
  /** owner/name */
  repository: string;
  fetch?: Fetch;
  now?: () => Date;
  timeoutMs?: number;
}

async function githubQuery<T>(
  opts: Omit<FetchForgeOptions, "repository">,
  query: string,
  variables: object,
): Promise<{ data?: T; errors?: { message: string }[] }> {
  return httpRequest(
    GITHUB_GRAPHQL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ query, variables }),
    },
    { ...opts, retry: true, retryStatus, service: "GitHub" },
    async (res) => {
      if (!res.ok) throw new GithubError(`GitHub API HTTP ${res.status}`);
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (json.errors?.length) throw new GithubError(`GitHub API: ${json.errors.map((e) => e.message).join("; ")}`);
      return json;
    },
  ).catch((err: unknown) => {
    if (err instanceof HttpStatusError) throw new GithubError(`GitHub API ${err.message}`);
    if (err instanceof HttpRequestError) throw new GithubError(`GitHub API unreachable: ${err.message}`);
    throw err;
  });
}

const PULL_QUERY = /* GraphQL */ `${PULL_FIELDS}
  query Pull($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...P } }
  }`;

/** One pull request with its head SHA and the checks on that head. */
export async function fetchPullRequest(opts: FetchForgeOptions & { number: number }): Promise<PullRequest | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{ repository: { pullRequest: RawPull | null } | null }>(opts, PULL_QUERY, {
    owner,
    name,
    number: opts.number,
  });
  const raw = json.data?.repository?.pullRequest;
  return raw ? normalizePull(raw, opts.repository) : null;
}

export async function fetchForge(opts: FetchForgeOptions): Promise<ForgeData> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{
    repository: {
      defaultBranchRef?: RawMainBranch | null;
      open: { nodes: RawPull[]; pageInfo?: { hasNextPage: boolean } };
      closed: { nodes: RawPull[] };
    } | null;
  }>(opts, PULLS_QUERY, { owner, name });
  const repo = json.data?.repository;
  if (!repo) throw new GithubError(`GitHub: repository ${opts.repository} not found`);
  return {
    repo: opts.repository,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    prs: [...repo.open.nodes, ...repo.closed.nodes].map((p) => normalizePull(p, opts.repository)),
    main: normalizeMain(repo.defaultBranchRef),
    mainComplete: repo.defaultBranchRef?.target.history?.pageInfo?.hasNextPage === false,
    warnings: [
      ...(repo.open.pageInfo?.hasNextPage
        ? ["more than 100 open pull requests; the least recently updated are ignored"]
        : []),
      ...repo.open.nodes.flatMap((pr) => [
        ...(pr.files?.pageInfo.hasNextPage ? [`PR #${pr.number}: changed files are incomplete (first 100)`] : []),
        ...(pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.pageInfo?.hasNextPage
          ? [`PR #${pr.number}: checks are incomplete (first 50)`]
          : []),
      ]),
    ],
  };
}

/** A fresh default-branch health reading for merge and queue callers. */
export async function fetchMainHealth(
  opts: FetchForgeOptions & { requiredChecks?: readonly string[] },
): Promise<MainHealth | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{ repository: { defaultBranchRef: RawMainBranch | null } | null }>(
    opts,
    `query MainHealth($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${MAIN_FIELDS} } }`,
    { owner, name },
  );
  if (!json.data?.repository) throw new GithubError(`GitHub: repository ${opts.repository} not found`);
  const branch = json.data.repository.defaultBranchRef;
  return mainHealth(
    normalizeMain(branch),
    opts.requiredChecks ?? [],
    branch?.target.history?.pageInfo?.hasNextPage === false,
  );
}

/**
 * Joins forge pull requests onto tracker issues: linked PRs are enriched by
 * URL, and PRs whose head branch names a ticket are added even if not linked.
 * Returns new issues; the inputs are left untouched.
 */
export function attachPullRequests(program: ProgramData, forge: ForgeData | null): Issue[] {
  if (!forge) return program.issues;
  const known = new Set(program.issues.map((i) => i.id));
  const byUrl = new Map(forge.prs.map((p) => [p.url, p]));
  const byTicket = new Map<string, PullRequest[]>();
  for (const p of forge.prs) {
    const id = p.headRef ? ticketIdFromBranch(p.headRef, known) : null;
    if (id) byTicket.set(id, [...(byTicket.get(id) ?? []), p]);
  }
  return program.issues.map((issue) => {
    const prs = issue.prs.map((p) => {
      const live = byUrl.get(p.url);
      return live ? { ...p, ...live, title: live.title || p.title } : p;
    });
    for (const p of byTicket.get(issue.id) ?? []) if (!prs.some((x) => x.url === p.url)) prs.push(p);
    return { ...issue, prs: prs.sort((a, b) => a.number - b.number) };
  });
}

const FILE_QUERY = /* GraphQL */ `
  query ArmadaConfig($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Blob { text } } }
  }`;

export interface FetchFileOptions extends HttpRequestOptions {
  token: string;
  /** owner/name */
  repository: string;
  /** Path from the repository root, e.g. armada.toml. */
  path: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** Text of a file on the repository's default branch, or null when the file does not exist there. */
export async function fetchDefaultBranchFile(opts: FetchFileOptions): Promise<string | null> {
  const [owner, name] = opts.repository.split("/");
  return httpRequest(
    GITHUB_GRAPHQL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ query: FILE_QUERY, variables: { owner, name, expression: `HEAD:${opts.path}` } }),
    },
    { ...opts, retry: true, retryStatus, service: "GitHub" },
    async (res) => {
      if (!res.ok) throw new GithubError(`GitHub API HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: { repository: { object: { text?: string | null } | null } | null };
        errors?: { message: string }[];
      };
      if (json.errors?.length) throw new GithubError(`GitHub API: ${json.errors.map((e) => e.message).join("; ")}`);
      if (!json.data?.repository) throw new GithubError(`GitHub: repository ${opts.repository} not found`);
      return json.data.repository.object?.text ?? null;
    },
  ).catch((err: unknown) => {
    if (err instanceof HttpStatusError) throw new GithubError(`GitHub API ${err.message}`);
    if (err instanceof HttpRequestError) throw new GithubError(`GitHub API unreachable: ${err.message}`);
    throw err;
  });
}

// ------------------------------------------------------------------ merge reads

/** A pull request as `armada merge` needs it: the fields of `PullRequest` plus what decides a merge. */
export interface MergePull extends PullRequest {
  state: "open" | "merged" | "closed";
  headSha: string;
  checks: { name: string; state: CiState }[];
  /** GitHub's mergeStateStatus: CLEAN, BEHIND, BLOCKED, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE. */
  mergeStateStatus: string;
  /** Name of the branch the pull request merges into. */
  baseRef: string;
  /** Squash or merge commit, once merged. */
  mergeCommit: string | null;
  reviewThreads: { total: number; read: number; unresolved: number };
}

const MERGE_PULL_QUERY = /* GraphQL */ `${PULL_FIELDS}
  query MergePull($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ...P
        mergeStateStatus baseRefName mergeCommit { oid }
        reviewThreads(first: 100) { totalCount nodes { isResolved } }
      }
    }
  }`;

type RawMergePull = RawPull & {
  mergeStateStatus: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  reviewThreads: { totalCount: number; nodes: { isResolved: boolean }[] };
};

/** One pull request with its mergeability, base branch and review threads. */
export async function fetchMergePull(opts: FetchForgeOptions & { number: number }): Promise<MergePull | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{ repository: { pullRequest: RawMergePull | null } | null }>(opts, MERGE_PULL_QUERY, {
    owner,
    name,
    number: opts.number,
  });
  const raw = json.data?.repository?.pullRequest;
  if (!raw) return null;
  const pr = normalizePull(raw, opts.repository);
  const threads = raw.reviewThreads.nodes;
  return {
    ...pr,
    state: pr.state ?? "open",
    headSha: raw.headRefOid,
    checks: pr.checks ?? [],
    mergeStateStatus: raw.mergeStateStatus,
    baseRef: raw.baseRefName,
    mergeCommit: raw.mergeCommit?.oid ?? null,
    reviewThreads: {
      total: raw.reviewThreads.totalCount,
      read: threads.length,
      unresolved: threads.filter((t) => !t.isResolved).length,
    },
  };
}

/** Where a head stands against a branch: BEHIND and DIVERGED mean the branch has commits the head lacks. */
export interface Comparison {
  /** Commit the branch points at. */
  baseSha: string;
  status: "AHEAD" | "BEHIND" | "DIVERGED" | "IDENTICAL";
  behindBy: number;
  aheadBy: number;
}

const COMPARE_QUERY = /* GraphQL */ `
  query Compare($owner: String!, $name: String!, $base: String!, $head: String!) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $base) { target { oid } compare(headRef: $head) { status aheadBy behindBy } }
    }
  }`;

/** Compares a head commit (SHA or branch) with a branch of the repository; null when either is unknown. */
export async function fetchComparison(
  opts: FetchForgeOptions & { base: string; head: string },
): Promise<Comparison | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{
    repository: {
      ref: {
        target: { oid: string };
        compare: { status: Comparison["status"]; aheadBy: number; behindBy: number } | null;
      } | null;
    } | null;
  }>(opts, COMPARE_QUERY, { owner, name, base: `refs/heads/${opts.base}`, head: opts.head });
  const ref = json.data?.repository?.ref;
  if (!ref?.compare) return null;
  return { baseSha: ref.target.oid, ...ref.compare };
}

/** The unified diff of a pull request (REST, diff media type). */
export async function fetchPullDiff(opts: FetchForgeOptions & { number: number }): Promise<string> {
  return httpRequest(
    `https://api.github.com/repos/${opts.repository}/pulls/${opts.number}`,
    {
      method: "GET",
      headers: { Accept: "application/vnd.github.diff", Authorization: `Bearer ${opts.token}` },
    },
    { ...opts, retry: true, retryStatus, service: "GitHub" },
    async (res) => {
      if (!res.ok) throw new GithubError(`GitHub API HTTP ${res.status} reading the diff of #${opts.number}`);
      return res.text();
    },
  ).catch((err: unknown) => {
    if (err instanceof HttpStatusError) throw new GithubError(`GitHub API ${err.message}`);
    if (err instanceof HttpRequestError) throw new GithubError(`GitHub API unreachable: ${err.message}`);
    throw err;
  });
}

/** A commit as `armada merge` checks an updated head: its parents and its tree. */
export interface CommitShape {
  sha: string;
  tree: string;
  parents: string[];
}

const COMMIT_QUERY = /* GraphQL */ `
  query Commit($owner: String!, $name: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) { ... on Commit { oid tree { oid } parents(first: 3) { nodes { oid } } } }
    }
  }`;

/** One commit of the repository; null when GitHub does not know it. */
export async function fetchCommit(opts: FetchForgeOptions & { sha: string }): Promise<CommitShape | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{
    repository: {
      object: { oid?: string; tree?: { oid: string }; parents?: { nodes: { oid: string }[] } } | null;
    } | null;
  }>(opts, COMMIT_QUERY, { owner, name, oid: opts.sha });
  const c = json.data?.repository?.object;
  if (!c?.oid || !c.tree || !c.parents) return null;
  return { sha: c.oid, tree: c.tree.oid, parents: c.parents.nodes.map((p) => p.oid) };
}

const PREVIEW_QUERY = /* GraphQL */ `
  query Preview($owner: String!, $name: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          deployments(last: 10) { nodes { environment latestStatus { state environmentUrl } } }
          status { contexts { context state targetUrl } }
        }
      }
    }
  }`;

const https = (url: string | null | undefined): string | null => {
  try {
    return url && new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The preview deployment of a commit, for the owner to try (THE-885): the
 * newest successful GitHub deployment's URL (a preview environment first),
 * else the target of a green Vercel status; null when there is none.
 */
export async function fetchPreview(opts: FetchForgeOptions & { sha: string }): Promise<string | null> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{
    repository: {
      object: {
        deployments?: {
          nodes: {
            environment: string | null;
            latestStatus: { state: string; environmentUrl: string | null } | null;
          }[];
        };
        status?: { contexts: { context: string; state: string; targetUrl: string | null }[] } | null;
      } | null;
    } | null;
  }>(opts, PREVIEW_QUERY, { owner, name, oid: opts.sha });
  const commit = json.data?.repository?.object;
  const deployed = (commit?.deployments?.nodes ?? [])
    .filter((d) => d.latestStatus?.state === "SUCCESS" && https(d.latestStatus.environmentUrl))
    .reverse();
  const preview = deployed.find((d) => /preview/i.test(d.environment ?? "")) ?? deployed[0];
  if (preview) return preview.latestStatus?.environmentUrl ?? null;
  const vercel = commit?.status?.contexts.find((c) => /vercel/i.test(c.context) && c.state === "SUCCESS");
  return https(vercel?.targetUrl);
}

// ------------------------------------------------------------ red CI diagnosis

const FAILED_CHECKS_QUERY = /* GraphQL */ `
  query FailedChecks($owner: String!, $name: String!, $sha: String!) {
    repository(owner: $owner, name: $name) { object(expression: $sha) { ... on Commit {
      oid
      status { contexts { context state targetUrl description } }
      checkSuites(first: 50) { pageInfo { hasNextPage } nodes {
        app { slug } commit { oid } branch { target { oid } }
        workflowRun { databaseId runNumber url workflow { name } }
        checkRuns(first: 50, filterBy: { conclusions: [FAILURE, TIMED_OUT, STARTUP_FAILURE, CANCELLED, ACTION_REQUIRED, STALE] }) {
          pageInfo { hasNextPage } nodes {
            databaseId name conclusion detailsUrl startedAt completedAt summary
            annotations(first: 30) { pageInfo { hasNextPage } nodes {
              path message title annotationLevel location { start { line } }
            } }
          }
        }
      } }
    } } }
  }`;

type Connection<T> = { nodes: (T | null)[]; pageInfo?: { hasNextPage: boolean } };
interface RawFailedCommit {
  oid: string;
  status: {
    contexts: { context: string; state: string; targetUrl: string | null; description: string | null }[];
  } | null;
  checkSuites: Connection<{
    app: { slug: string } | null;
    commit: { oid: string };
    branch?: { target: { oid: string } } | null;
    workflowRun: { databaseId: number } | null;
    checkRuns: Connection<{
      databaseId: number | null;
      name: string;
      conclusion: string;
      detailsUrl: string | null;
      summary: string | null;
      annotations: Connection<{
        title: string | null;
        message: string;
        path: string;
        location: { start: { line: number } };
      }> | null;
    }>;
  }>;
}

/** Failed check runs and commit statuses on one pinned commit; no Linear access. */
export async function fetchFailedChecks(opts: FetchForgeOptions & { sha: string; headSha?: string }): Promise<{
  sha: string;
  checks: import("./ci.ts").FailedCheck[];
  warnings: string[];
}> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{ repository: { object: RawFailedCommit | null } | null }>(opts, FAILED_CHECKS_QUERY, {
    owner,
    name,
    sha: opts.sha,
  });
  const commit = json.data?.repository?.object;
  if (!commit?.oid) throw new GithubError(`GitHub: commit ${opts.sha} not found in ${opts.repository}`);
  const checks: import("./ci.ts").FailedCheck[] = [];
  const warnings: string[] = [];
  if (commit.checkSuites.pageInfo?.hasNextPage)
    warnings.push("CI reading is incomplete: only the first 50 check suites were read");
  const ids = new Set<number>();
  for (const suite of commit.checkSuites.nodes) {
    if (!suite) continue;
    if (suite.checkRuns.pageInfo?.hasNextPage)
      warnings.push("CI reading is incomplete: only the first 50 failing checks of a suite were read");
    for (const run of suite.checkRuns.nodes) {
      if (!run || (run.databaseId !== null && ids.has(run.databaseId))) continue;
      if (run.databaseId !== null) ids.add(run.databaseId);
      if (run.annotations?.pageInfo?.hasNextPage) warnings.push(`${run.name}: annotations are incomplete (first 30)`);
      const headSha = suite.commit.oid;
      checks.push({
        id: run.databaseId,
        name: run.name,
        conclusion: run.conclusion,
        url: run.detailsUrl,
        app: suite.app?.slug ?? null,
        runId: suite.workflowRun?.databaseId ?? null,
        headSha,
        summary: run.summary,
        annotations: (run.annotations?.nodes ?? []).flatMap((a) =>
          a
            ? [
                {
                  title: a.title,
                  message: a.message,
                  path: a.path,
                  line: a.location.start.line,
                },
              ]
            : [],
        ),
        ...(run.conclusion === "CANCELLED" &&
        (opts.headSha ?? suite.branch?.target.oid) &&
        headSha !== (opts.headSha ?? suite.branch?.target.oid)
          ? { superseded: true }
          : {}),
      });
    }
  }
  for (const status of commit.status?.contexts ?? []) {
    if (!["FAILURE", "ERROR"].includes(status.state)) continue;
    checks.push({
      id: null,
      name: status.context,
      conclusion: status.state,
      url: status.targetUrl,
      app: null,
      runId: null,
      headSha: commit.oid,
      summary: status.description,
      annotations: [],
    });
  }
  return { sha: commit.oid, checks, warnings };
}

/** Resolve a named branch to its commit, without reading Linear or the fleet. */
export async function fetchBranchHead(opts: FetchForgeOptions & { branch: string }): Promise<string> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{ repository: { ref: { target: { oid: string } } | null } | null }>(
    opts,
    `
    query CiBranch($owner: String!, $name: String!, $branch: String!) {
      repository(owner: $owner, name: $name) { ref(qualifiedName: $branch) { target { oid } } }
    }`,
    { owner, name, branch: `refs/heads/${opts.branch}` },
  );
  const sha = json.data?.repository?.ref?.target.oid;
  if (!sha) throw new GithubError(`GitHub: branch ${opts.branch} not found in ${opts.repository}`);
  return sha;
}

const GITHUB_REST = "https://api.github.com";
const LOG_BYTES = 5 * 1024 * 1024;

/** Actions job log: bounded streaming read, redirects never carry a key off GitHub. */
export async function fetchJobLog(opts: FetchForgeOptions & { jobId: number }): Promise<import("./ci.ts").JobLog> {
  const warnings: string[] = [];
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" };
  const readLog = async (res: Response): Promise<string[]> => {
    if (!res.ok)
      throw new GithubError(
        `HTTP ${res.status}; logs may have expired or the token needs Actions repository permission (read)`,
      );
    if (!res.body) return [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let partial = "";
    let lines: string[] = [];
    let totalLines = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const take = chunk.value.subarray(0, LOG_BYTES - bytes);
        bytes += take.byteLength;
        const parts = (partial + decoder.decode(take, { stream: true })).split("\n");
        partial = parts.pop() ?? "";
        totalLines += parts.length;
        lines = [...lines, ...parts].slice(-3000);
        if (bytes >= LOG_BYTES) {
          warnings.push(`job ${opts.jobId}: log stopped at 5 MB; diagnosis may be incomplete`);
          break;
        }
      }
      partial += decoder.decode();
      if (partial) {
        lines.push(partial);
        totalLines++;
      }
      if (totalLines > 3000)
        warnings.push(`job ${opts.jobId}: only the last 3000 log lines were kept; earlier errors may be missing`);
      return lines.slice(-3000);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  try {
    let url = `${GITHUB_REST}/repos/${opts.repository}/actions/jobs/${opts.jobId}/logs`;
    let authorized = true;
    for (let hop = 0; hop < 5; hop++) {
      const result: { lines?: string[]; redirect?: string } = await httpRequest(
        url,
        { headers: authorized ? headers : {}, redirect: "manual" },
        { ...opts, retry: true, retryStatus, service: "GitHub" },
        async (res) => {
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get("Location");
            if (!location) throw new GithubError("log redirect has no location");
            return { redirect: new URL(location, url).toString() };
          }
          return { lines: await readLog(res) };
        },
      );
      if (result.lines) return { lines: result.lines, warnings };
      const next = new URL(result.redirect ?? "");
      if (next.protocol !== "https:" || next.username || next.password) throw new GithubError("unsafe log redirect");
      authorized = authorized && next.origin === GITHUB_REST;
      url = next.toString();
    }
    throw new GithubError("too many log redirects");
  } catch (err) {
    warnings.push(
      `job ${opts.jobId}: log unavailable (${err instanceof HttpRequestError ? "GitHub unreachable" : err instanceof Error ? err.message : "read failed"}); using annotations and summary`,
    );
    return { lines: [], warnings };
  }
}

/** Attempt number for an Actions workflow run. Log access remains optional. */
export async function fetchRunAttempt(opts: FetchForgeOptions & { runId: number }): Promise<number> {
  return httpRequest(
    `${GITHUB_REST}/repos/${opts.repository}/actions/runs/${opts.runId}`,
    {
      headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" },
    },
    { ...opts, retry: true, retryStatus, service: "GitHub" },
    async (res) => {
      if (!res.ok)
        throw new GithubError(`GitHub Actions HTTP ${res.status}; token needs Actions repository permission (read)`);
      const json = (await res.json()) as { run_attempt?: number };
      if (!Number.isSafeInteger(json.run_attempt) || (json.run_attempt ?? 0) < 1)
        throw new GithubError("GitHub Actions returned no run attempt");
      return json.run_attempt as number;
    },
  );
}

/** Commit ancestry by SHA; branch-based fetchComparison cannot compare two commits. */
export async function fetchShaComparison(opts: FetchForgeOptions & { base: string; head: string }): Promise<boolean> {
  return httpRequest(
    `https://api.github.com/repos/${opts.repository}/compare/${encodeURIComponent(opts.base)}...${encodeURIComponent(opts.head)}`,
    { method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${opts.token}` } },
    { ...opts, retry: true, retryStatus, service: "GitHub" },
    async (res) => {
      if (!res.ok) throw new GithubError(`GitHub API HTTP ${res.status} comparing deploy commits`);
      const comparison = (await res.json()) as { status: string };
      return comparison.status === "ahead" || comparison.status === "identical";
    },
  );
}

/** One read per poll, independent of the hosting provider or preview status contexts. */
export async function fetchLiveDeploy(
  opts: FetchForgeOptions & { environment: string },
): Promise<import("./deploy.ts").LiveDeploy> {
  const [owner, name] = opts.repository.split("/");
  const json = await githubQuery<{
    repository: {
      deployments: {
        nodes: {
          commit: { oid: string } | null;
          latestStatus: { state: string; description: string | null } | null;
        }[];
      };
    } | null;
  }>(
    opts,
    `query LiveDeploy($owner: String!, $name: String!, $environment: String!) {
    repository(owner: $owner, name: $name) {
      deployments(last: 1, environments: [$environment], orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes { commit { oid } latestStatus { state description } }
      }
    }
  }`,
    { owner, name, environment: opts.environment },
  );
  const deploy = json.data?.repository?.deployments.nodes[0];
  const state = deploy?.latestStatus?.state?.toLowerCase();
  return {
    sha: deploy?.commit?.oid ?? null,
    state: state === "success" || state === "failure" || state === "error" ? state : "pending",
    detail: deploy
      ? `${opts.environment}: ${state ?? "pending"}\n${deploy.latestStatus?.description ?? ""}`
      : `no deployment for ${opts.environment}`,
  };
}
