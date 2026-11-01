import type { EventInput, GithubPullRequest } from "@armada/daemon/events";
import type { PrCursor, ReviewComment } from "./checkpoint.ts";
import { type GithubHttp, GithubReadError } from "./http.ts";

const THREADS = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
      id isResolved path line comments(first: 1) { nodes { databaseId author { login } body url createdAt updatedAt } }
    } }
  } }
}`;
export type ReviewFact = Extract<
  EventInput,
  { kind: "pull-request.commented" | "review-thread.opened" | "review-thread.resolved" }
>;
type Payload = Extract<ReviewFact, { kind: "pull-request.commented" }>["payload"];
interface RawComment {
  id?: number;
  databaseId?: number;
  in_reply_to_id?: number;
  body: string;
  user?: { login: string };
  author?: { login: string } | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  html_url?: string;
  url?: string;
  path?: string;
  line?: number | null;
}
export interface RawThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { nodes: RawComment[] };
}
function comment(raw: RawComment, http: GithubHttp): ReviewComment {
  const id = raw.id ?? raw.databaseId;
  const author = raw.user?.login ?? raw.author?.login ?? "deleted-user";
  const at = raw.created_at ?? raw.createdAt ?? "";
  const updated = raw.updated_at ?? raw.updatedAt ?? at;
  const url = raw.html_url ?? raw.url;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof raw.body !== "string" ||
    typeof author !== "string" ||
    typeof url !== "string" ||
    !/^https?:\/\//.test(url) ||
    !Number.isFinite(Date.parse(at ?? "")) ||
    !Number.isFinite(Date.parse(updated ?? ""))
  )
    throw new GithubReadError("GitHub comments reading is incomplete");
  return {
    id: String(id),
    root: String(raw.in_reply_to_id ?? id),
    author: http.clean(author),
    body: http.clean(raw.body).slice(0, 600),
    url: http.clean(url),
    at,
    updatedAt: updated,
    path: typeof raw.path === "string" ? http.clean(raw.path) : "",
    line: Number.isSafeInteger(raw.line) && raw.line != null && raw.line >= 0 ? raw.line : null,
  };
}
/** REST offers `since` and ETags; GraphQL threads offer authoritative resolution, but no `since`. */
export async function readReviews(
  http: GithubHttp,
  pr: GithubPullRequest,
  prior: PrCursor,
  at: string,
  signal: AbortSignal,
): Promise<{ state: PrCursor; events: ReviewFact[]; unresolved: number }> {
  const state = structuredClone(prior);
  const events: ReviewFact[] = [];
  const payload = (c: ReviewComment, key: string): Payload => ({
    key,
    repository: pr.repository,
    ticket: pr.ticket,
    pr: pr.number,
    head: pr.head,
    author: c.author,
    body: c.body,
    url: c.url,
    at: c.at,
    comment: c.id,
    version: c.updatedAt,
    ...(pr.author ? { worker: pr.author } : {}),
  });
  const prefix = `${pr.repository}:${pr.number}`;
  for (const resource of ["pulls", "issues"] as const) {
    const etagKey = resource === "pulls" ? "etag" : "issueEtag";
    const seenPages = new Set<string>();
    let url = `${http.rest}/repos/${pr.repository}/${resource}/${pr.number}/comments?per_page=100`;
    if (state.cursor) url += `&since=${encodeURIComponent(new Date(Date.parse(state.cursor) - 5000).toISOString())}`;
    let etag: string | undefined;
    let first = true;
    let notModified = false;
    for (;;) {
      // Page-local ETags cannot validate later pages. Only use a single-page response's ETag.
      const response = await http.request(url, signal, {
        headers: first && state[etagKey] ? { "if-none-match": state[etagKey] } : {},
      });
      if (response.status === 304) {
        notModified = true;
        break;
      }
      const body = (await response.json()) as RawComment[];
      signal.throwIfAborted();
      if (!Array.isArray(body)) throw new GithubReadError("GitHub comments reading is incomplete");
      for (const raw of body) {
        const c = comment(raw, http);
        if (resource === "issues") {
          c.id = `issue-${c.id}`;
          c.root = c.id;
        }
        if (state.comments[c.id]?.updatedAt !== c.updatedAt)
          events.push({
            kind: "pull-request.commented",
            payload: payload(c, `${prefix}:comment:${c.id}:${c.updatedAt}`),
          } as ReviewFact);
        state.comments[c.id] = c;
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      if (!next) {
        if (first) etag = http.etag(response);
        break;
      }
      const target = new URL(next);
      if (
        target.origin !== new URL(http.rest).origin ||
        target.pathname !== new URL(url).pathname ||
        seenPages.has(next) ||
        seenPages.size >= 100
      )
        throw new GithubReadError("GitHub pagination did not complete");
      seenPages.add(next);
      url = next;
      first = false;
    }
    state[etagKey] = notModified ? state[etagKey] : etag;
  }
  // Resolve reply chains even when GitHub returns replies before their roots.
  for (const c of Object.values(state.comments)) {
    let root = c.root;
    const visited = new Set([c.id]);
    while (state.comments[root] && state.comments[root]!.root !== root) {
      if (visited.has(root)) throw new GithubReadError("GitHub comments reading is incomplete");
      visited.add(root);
      root = state.comments[root]!.root;
    }
    c.root = root;
  }
  const [owner, name] = pr.repository.split("/");
  let after: string | null = null;
  const cursors = new Set<string>();
  const threads: Record<string, PrCursor["threads"][string]> = {};
  for (;;) {
    const reading = await http.query(THREADS, { owner, name, number: pr.number, after }, signal);
    const connection = reading.pullRequest?.reviewThreads;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean")
      throw new GithubReadError("GitHub comments reading is incomplete");
    for (const raw of connection.nodes) {
      if (
        typeof raw.id !== "string" ||
        typeof raw.isResolved !== "boolean" ||
        typeof raw.path !== "string" ||
        !raw.comments?.nodes?.[0]
      )
        throw new GithubReadError("GitHub comments reading is incomplete");
      const root = comment({ ...raw.comments.nodes[0], path: raw.path, line: raw.line }, http);
      const c = state.comments[root.root] ?? root;
      const threadId = http.clean(raw.id);
      const before = prior.threads[threadId];
      threads[threadId] = {
        resolved: raw.isResolved,
        cycle: (before?.cycle ?? 0) + (before && before.resolved !== raw.isResolved ? 1 : 0),
        comment: c,
      };
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after) || cursors.size >= 100)
      throw new GithubReadError("GitHub pagination did not complete");
    cursors.add(after);
  }
  const unresolved = Object.values(threads).filter((t) => !t.resolved).length;
  for (const [id, t] of Object.entries(threads)) {
    const before = prior.threads[id];
    if ((!before && !t.resolved) || (before && before.resolved !== t.resolved))
      events.push({
        kind: t.resolved ? "review-thread.resolved" : "review-thread.opened",
        payload: {
          ...payload(t.comment, `${prefix}:thread:${id}:${t.cycle}:${t.resolved}`),
          thread: id,
          path: t.comment.path,
          line: t.comment.line,
          unresolvedThreads: unresolved,
        },
      } as ReviewFact);
  }
  if (pr.base) {
    const key = `${pr.base}...${pr.head}`;
    const response = await http.request(
      `${http.rest}/repos/${pr.repository}/compare/${encodeURIComponent(key)}`,
      signal,
      { headers: state.compareKey === key && state.compareEtag ? { "if-none-match": state.compareEtag } : {} },
    );
    if (response.status !== 304) {
      const comparison = (await response.json()) as { behind_by?: number };
      signal.throwIfAborted();
      if (!Number.isSafeInteger(comparison.behind_by) || comparison.behind_by == null || comparison.behind_by < 0)
        throw new GithubReadError("GitHub returned an incomplete reading");
      state.compareBehind = comparison.behind_by > 0;
      state.compareKey = key;
      state.compareEtag = http.etag(response);
    } else if (state.compareKey !== key || state.compareBehind === undefined)
      throw new GithubReadError("GitHub returned an incomplete reading");
  }
  state.cursor = at;
  state.threads = threads;
  state.failures = 0;
  delete state.failedSince;
  delete state.error;
  return { state, events, unresolved };
}
