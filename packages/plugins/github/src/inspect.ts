import type { ForgeInspection } from "@armada/plugin-api";
import { normalize, type RawPull } from "./normalize.ts";

type GithubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const SHA = /^[0-9a-f]{40}$/i;
const REST_DEFAULT = "https://api.github.com";
const GRAPHQL_DEFAULT = `${REST_DEFAULT}/graphql`;

/**
 * Keep the endpoint convention used by the reader (an endpoint is the
 * GraphQL URL), while making the REST half work with both the public API and
 * local recorded fixtures that expose `/graphql` from one origin.
 */
function restEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return REST_DEFAULT;
  try {
    const url = new URL(endpoint);
    if (url.pathname.replace(/\/+$/, "") === "/graphql")
      url.pathname = url.pathname.replace(/\/+$/, "").slice(0, -"/graphql".length) || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint.replace(/\/graphql\/?$/, "").replace(/\/$/, "");
  }
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function cleanSha(value: unknown): string {
  if (!validSha(value)) throw new Error("invalid SHA");
  return value.toLowerCase();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid GitHub response");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid GitHub response");
  return value;
}

function pageInfo(value: unknown): { hasNextPage: boolean; endCursor: string | null } {
  const page = object(value);
  if (typeof page.hasNextPage !== "boolean") throw new Error("invalid GitHub pagination");
  if (page.endCursor !== undefined && page.endCursor !== null && typeof page.endCursor !== "string")
    throw new Error("invalid GitHub pagination");
  return { hasNextPage: page.hasNextPage, endCursor: (page.endCursor as string | null | undefined) ?? null };
}

const INSPECT_QUERY = `fragment InspectPull on PullRequest {
  number title url state isDraft mergeable mergeStateStatus headRefName headRefOid reviewDecision
  baseRef { name target { oid } }
  mergeCommit { oid }
  commits(last: 1) { nodes { commit { oid
    checkSuites(first: 50) { nodes { status conclusion commit { oid } workflowRun { databaseId runNumber runAttempt workflow { id } } } pageInfo { hasNextPage endCursor } }
    statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage endCursor } nodes {
      __typename
      ... on CheckRun { name status conclusion checkSuite { status conclusion commit { oid } workflowRun { databaseId runNumber runAttempt workflow { id } } } }
      ... on StatusContext { context state }
    } } }
  } } }
  reviewThreads(first: 100, after: $reviewAfter) {
    totalCount nodes { isResolved }
    pageInfo { hasNextPage endCursor }
  }
}
query InspectPull($owner: String!, $name: String!, $number: Int!, $reviewAfter: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...InspectPull } }
}`;

const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        totalCount nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface InspectOptions {
  endpoint?: string;
  repository: string;
  number: number;
  token: string;
  signal: AbortSignal;
  fetch: GithubFetch;
  now?: () => Date;
}

interface RawInspection extends RawPull {
  baseRef: { name: string; target: { oid: string } | null } | null;
  mergeCommit: { oid: string } | null;
  reviewThreads: {
    totalCount: number;
    nodes: { isResolved: boolean }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface ThreadPage {
  totalCount: number;
  nodes: { isResolved: boolean }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function inspectRequest<T>(
  options: InspectOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  options.signal.throwIfAborted();
  const response = await options.fetch(options.endpoint ?? GRAPHQL_DEFAULT, {
    method: "POST",
    redirect: "error",
    signal: options.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error("GitHub request failed");
  const body = object(await response.json());
  if (Array.isArray(body.errors) && body.errors.length) throw new Error("GitHub returned an incomplete reading");
  const data = object(body.data);
  options.signal.throwIfAborted();
  return data as T;
}

async function restRequest<T>(
  options: InspectOptions,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null }> {
  options.signal.throwIfAborted();
  const response = await options.fetch(`${restEndpoint(options.endpoint)}${path}`, {
    ...init,
    redirect: "error",
    signal: options.signal,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      ...init.headers,
    },
  });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    if (response.ok) throw new Error("GitHub returned an incomplete reading");
  }
  options.signal.throwIfAborted();
  return { status: response.status, body };
}

function checkThreadPage(value: unknown): ThreadPage {
  const page = object(value);
  if (!Number.isSafeInteger(page.totalCount) || (page.totalCount as number) < 0)
    throw new Error("invalid review threads");
  const nodes = array(page.nodes).map((node) => {
    const item = object(node);
    if (typeof item.isResolved !== "boolean") throw new Error("invalid review thread");
    return { isResolved: item.isResolved };
  });
  return { totalCount: page.totalCount as number, nodes, pageInfo: pageInfo(page.pageInfo) };
}

async function readReviewThreads(
  options: InspectOptions,
  first: ThreadPage,
): Promise<ForgeInspection["reviewThreads"]> {
  let total = first.totalCount;
  let read = first.nodes.length;
  let unresolved = first.nodes.filter((thread) => !thread.isResolved).length;
  let complete = true;
  let page = first;
  const cursors = new Set<string>();
  for (let count = 0; page.pageInfo.hasNextPage; count++) {
    const after = page.pageInfo.endCursor;
    if (!after || cursors.has(after) || count >= 100) {
      complete = false;
      break;
    }
    cursors.add(after);
    const data = await inspectRequest<{ repository: { pullRequest: { reviewThreads: unknown } | null } | null }>(
      options,
      REVIEW_THREADS_QUERY,
      {
        owner: options.repository.split("/")[0],
        name: options.repository.split("/")[1],
        number: options.number,
        after,
      },
    );
    const next = data.repository?.pullRequest?.reviewThreads;
    if (next === undefined || next === null) throw new Error("GitHub returned incomplete review threads");
    page = checkThreadPage(next);
    if (page.totalCount !== total) complete = false;
    total = Math.max(total, page.totalCount);
    read += page.nodes.length;
    unresolved += page.nodes.filter((thread) => !thread.isResolved).length;
  }
  if (total !== read) complete = false;
  return { complete, total, read, unresolved };
}

function requiredChecks(value: unknown): string[] {
  const body = object(value);
  const nested = Object.hasOwn(body, "required_status_checks");
  const required = nested ? body.required_status_checks : body;
  if (required === null) return [];
  if (nested && (typeof required !== "object" || Array.isArray(required)))
    throw new Error("invalid branch protection checks");
  const rules = object(required);
  const hasContexts = Object.hasOwn(rules, "contexts");
  const hasChecks = Object.hasOwn(rules, "checks");
  if (!hasContexts && !hasChecks) {
    // A full protection response may omit required_status_checks altogether;
    // its resource URL is the proof that this is a complete, empty policy.
    // An empty focused response (or nested empty required checks) is not.
    if (!nested && typeof body.url === "string" && isUrl(body.url)) return [];
    throw new Error("invalid branch protection checks");
  }
  const contexts = hasContexts ? array(rules.contexts) : [];
  const checks = hasChecks ? array(rules.checks) : [];
  const names: string[] = [];
  for (const context of contexts) {
    if (typeof context !== "string" || !context) throw new Error("invalid branch protection checks");
    names.push(context);
  }
  for (const check of checks) {
    const item = object(check);
    if (typeof item.context !== "string" || !item.context) throw new Error("invalid branch protection checks");
    names.push(item.context);
  }
  return [...new Set(names)].sort();
}

function isUrl(value: string): boolean {
  try {
    return !!new URL(value).protocol && !!new URL(value).host;
  } catch {
    return false;
  }
}

async function readRequiredChecks(options: InspectOptions, baseRef: string): Promise<string[]> {
  const branch = encodeURIComponent(baseRef);
  const result = await restRequest<unknown>(options, `/repos/${options.repository}/branches/${branch}/protection`);
  // A branch with no protection has no required checks. A permission failure
  // is not evidence of that and therefore remains a hard, sanitized failure.
  if (result.status === 404) return [];
  if (result.status < 200 || result.status >= 300 || result.body === null)
    throw new Error("GitHub branch protection failed");
  return requiredChecks(result.body);
}

async function readBehindBy(options: InspectOptions, base: string, head: string): Promise<number> {
  const result = await restRequest<unknown>(options, `/repos/${options.repository}/compare/${base}...${head}`);
  if (result.status < 200 || result.status >= 300 || result.body === null) throw new Error("GitHub comparison failed");
  const body = object(result.body);
  if (!Number.isSafeInteger(body.behind_by) || (body.behind_by as number) < 0)
    throw new Error("invalid GitHub comparison");
  const sha = object(body.base_commit).sha;
  if (!validSha(sha) || sha.toLowerCase() !== base) throw new Error("GitHub comparison was not pinned to base");
  const headCommit = body.head_commit;
  if (headCommit !== undefined && headCommit !== null) {
    const sha = object(headCommit).sha;
    if (!validSha(sha) || sha.toLowerCase() !== head) throw new Error("GitHub comparison was not pinned to head");
  }
  return body.behind_by as number;
}

/** Read one fresh, complete-or-explicitly-incomplete merge evidence snapshot. */
export async function inspectGithub(options: InspectOptions): Promise<ForgeInspection> {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error("invalid repository");
    if (!Number.isSafeInteger(options.number) || options.number <= 0) throw new Error("invalid pull request number");
    if (!options.token || /\s/.test(options.token)) throw new Error("invalid credentials");
    const [owner, name] = options.repository.split("/");
    const data = await inspectRequest<{ repository: { pullRequest: RawInspection | null } | null }>(
      options,
      INSPECT_QUERY,
      {
        owner,
        name,
        number: options.number,
        reviewAfter: null,
      },
    );
    const raw = data.repository?.pullRequest;
    if (!raw) throw new Error("pull request not found");
    // normalize performs the pinned-head check and the complete-head-checks
    // derivation used by the reader, so inspection and event observations
    // cannot disagree about check states.
    const normalized = normalize(raw, options.repository, new Set(), options.token);
    if (normalized.number !== options.number) throw new Error("pull request number changed");
    if (!raw.baseRef || typeof raw.baseRef.name !== "string" || !raw.baseRef.name || !raw.baseRef.target)
      throw new Error("missing base reference");
    const head = cleanSha(raw.headRefOid);
    const base = cleanSha(raw.baseRef.target.oid);
    if (normalized.head.toLowerCase() !== head) throw new Error("head changed during inspection");
    if (typeof raw.mergeStateStatus !== "string") throw new Error("invalid merge state");
    const mergeCommit = raw.mergeCommit === null ? null : cleanSha(raw.mergeCommit?.oid);
    const threads = checkThreadPage(raw.reviewThreads);
    const review = await readReviewThreads(options, threads);
    const behindBy = await readBehindBy(options, base, head);
    const required = await readRequiredChecks(options, raw.baseRef.name);
    const inspection = {
      number: normalized.number,
      head,
      base,
      baseRef: raw.baseRef.name,
      state: normalized.state,
      title: normalized.title,
      url: normalized.url,
      draft: normalized.draft,
      mergeState: raw.mergeStateStatus,
      mergeCommit,
      observedAt: (options.now?.() ?? new Date()).toISOString(),
      behindBy,
      checksComplete: normalized.checksComplete,
      checks: normalized.checks.map((check) => ({ name: check.name, state: check.state })),
      requiredChecks: required,
      reviewThreads: review,
    } satisfies ForgeInspection;
    // The plugin API schema is deliberately owned by plugin-api; this manual
    // shape is kept explicit here so malformed remote fields never cross the
    // provider boundary even when a consumer does not parse again.
    if (!inspection.observedAt || !inspection.url || !inspection.title) throw new Error("incomplete inspection");
    return inspection;
  } catch {
    throw new Error("GitHub inspection failed");
  }
}

export type { GithubFetch };
