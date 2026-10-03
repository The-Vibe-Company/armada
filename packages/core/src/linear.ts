// Linear read adapter: walks the program tree from its root issue at any depth,
// then reads the comments of the tickets an agent may hold. The normalizers are
// pure and exported so they can be tested on recorded responses.
import type { AgentClaim, AgentPhase, Blocker, Comment, Issue, LabelPhase, ProgramData, StatusType } from "./types.ts";
import { LABEL_PHASES } from "./types.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const MAX_DEPTH = 8;
// Linear rejects queries above a complexity budget (roughly nodes requested,
// multiplied through nested connections), so the tree query reads only a first
// page of each connection per issue. Any connection Linear reports as longer is
// then read to the end, one issue at a time, with `MORE_PAGE` nodes per request.
const COMMENT_BATCH = 25;
const MAX_COMMENTS = 100;
const MORE_PAGE = 100;
export const REQUEST_TIMEOUT_MS = 30_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LabelGroups {
  phaseGroup: string;
  runtimeGroup: string;
}

export interface FetchProgramOptions {
  apiKey: string;
  rootId: string;
  labels: LabelGroups;
  fetch?: Fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export class LinearError extends Error {
  override name = "LinearError";
  /** True when Linear could not be reached or refused the request as a whole (network, key, HTTP status). */
  constructor(
    message: string,
    readonly transport = false,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ parsers

const PHASES: AgentPhase[] = [...LABEL_PHASES, "released", "merged"];
/** Older status-line words mapped onto the protocol. */
const LEGACY: Record<string, AgentPhase> = { "handed-back": "ready-to-merge", "ci-fixing": "shipping" };

const firstLine = (body: string) => (body.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`]/g, "");

/**
 * Summaries of the coordinator's records (`armada answer`, `armada answer --note`).
 * They keep the `Agent status:` format but are not the worker's report: they
 * never count as a phase, a hand-back or a sign that the worker is alive.
 */
export const COORDINATOR_RECORD = /^(?:answer|note)\s*:/i;

/** The plan block `armada report --plan` puts under the status line. */
const PLAN_BLOCK = /^## Plan[ \t]*$/m;

/** First line "Agent status: <phase> — <summary>" (em dash, en dash or hyphen). */
export function parseStatusLine(body: string): Comment["status"] {
  const m = firstLine(body).match(/^\s*Agent status\s*:\s*([a-z-]+)\s*(?:[—–-]+\s*(.*))?$/i);
  if (!m?.[1]) return null;
  const raw = m[1].toLowerCase();
  const phase = LEGACY[raw] ?? (raw as AgentPhase);
  const summary = (m[2] ?? "").trim();
  if (COORDINATOR_RECORD.test(summary)) return null;
  if (!PHASES.includes(phase)) return null;
  return PLAN_BLOCK.test(body) ? { phase, summary, plan: true } : { phase, summary };
}

/** Removes markdown backslash escapes (Linear stores `a_b` as `a\_b`). */
const unescapeMarkdown = (line: string) => line.replace(/\\([!-/:-@[-`{-~])/g, "$1");
/** Emphasis wrapped around a whole value (`x`, **x**, _x_), never marks that belong to it. */
const trimMarks = (v: string) => {
  const t = v.trim();
  return t.match(/^([*_`]+)(.+)\1$/)?.[2]?.trim() ?? t;
};

/**
 * The line "Agent claim — runtime: X · session: Y · branch: Z · started: D",
 * optionally followed by "· profile: P".
 * It may follow the comment's `Agent status:` line. Values keep their
 * underscores and asterisks; only emphasis around them is removed.
 */
export function parseClaim(body: string, at: string, author: string | null): AgentClaim | null {
  const line = body
    .split("\n")
    .map(unescapeMarkdown)
    .find((l) => /^[\s*_`>]*Agent claim\b/i.test(l));
  if (!line) return null;
  const field = (k: string) => {
    const v = line.match(new RegExp(`(?:${k})[*_\`]*\\s*:\\s*([^·|]+)`, "i"))?.[1];
    return (v && trimMarks(v)) || null;
  };
  const profileReason = body
    .split("\n")
    .map(unescapeMarkdown)
    .find((entry) => entry.startsWith("Profile reason: "))
    ?.slice("Profile reason: ".length)
    .trim();
  return {
    runtime: field("runtime"),
    session: field("session"),
    branch: field("branch|branche"),
    startedAt: field("started|démarré|demarre"),
    profile: field("profile"),
    ...(profileReason ? { profileReason } : {}),
    at,
    author,
  };
}

export function excerpt(markdown: string, max = 240): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\(<?[^)]*>?\)/g, "$1")
    .replace(/[#*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function parsePullRequestUrl(url: string, title = ""): Issue["prs"][number] | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  return m?.[1] && m[2]
    ? { url: `https://github.com/${m[1]}/pull/${m[2]}`, repo: m[1], number: Number(m[2]), title }
    : null;
}

/** Agent phase and runtime from labels, read only inside the configured groups. */
export function agentLabels(labels: { name: string; group: string | null }[], groups: LabelGroups) {
  let agentPhase: LabelPhase | null = null;
  for (const l of labels) if (l.group === groups.phaseGroup) agentPhase ??= phaseNamed(l.name);
  const runtime = labels.find((l) => l.group === groups.runtimeGroup);
  return { agentPhase, agentRuntime: runtime?.name ?? null };
}

/** Compares names ignoring case, spaces, dashes and punctuation ("Ready to merge" = "ready-to-merge"). */
export const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The protocol phase a label name stands for, if any. */
export const phaseNamed = (name: string): LabelPhase | null => LABEL_PHASES.find((p) => sameName(p, name)) ?? null;

// ------------------------------------------------------------------ raw shapes

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  state: { name: string; type: string };
  assignee: { name: string } | null;
  delegate?: { name: string } | null;
  parent: { identifier: string } | null;
  labels: Connection<{ name: string; parent: { name: string } | null }>;
  attachments: Connection<{ title: string; url: string }>;
  inverseRelations: Connection<{ type: string; issue: { identifier: string; state: { type: string } } }>;
}

/** A Linear connection; `pageInfo.hasNextPage` tells that more nodes follow `endCursor`. */
export interface Connection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
}

export interface RawComment {
  id: string;
  createdAt: string;
  body: string;
  user: { name: string } | null;
}

export function normalizeIssue(raw: RawIssue, groups: LabelGroups): Issue {
  // "A blocks B" is stored on A; B sees it through its inverse relations.
  const blockers = new Map<string, Blocker>();
  for (const r of raw.inverseRelations.nodes)
    if (r.type === "blocks")
      blockers.set(r.issue.identifier, { id: r.issue.identifier, statusType: r.issue.state.type as StatusType });
  const prs = new Map<string, Issue["prs"][number]>();
  for (const a of raw.attachments.nodes) {
    const pr = parsePullRequestUrl(a.url, a.title);
    if (pr) prs.set(pr.url, pr);
  }
  for (const m of raw.description?.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g) ?? []) {
    const pr = parsePullRequestUrl(m[0]);
    if (pr && !prs.has(pr.url)) prs.set(pr.url, pr);
  }
  const labels = raw.labels.nodes.map((l) => ({ name: l.name, group: l.parent?.name ?? null }));
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    url: raw.url,
    status: raw.state.name,
    statusType: raw.state.type as StatusType,
    assignee: raw.assignee?.name ?? null,
    delegate: raw.delegate?.name ?? null,
    labels: labels.map((l) => l.name),
    ...agentLabels(labels, groups),
    parentId: raw.parent?.identifier ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    canceledAt: raw.canceledAt,
    blockedBy: [...blockers.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
  };
}

export function normalizeComment(raw: RawComment, issueId: string): Comment {
  const author = raw.user?.name ?? null;
  return {
    id: raw.id,
    issueId,
    author,
    createdAt: raw.createdAt,
    excerpt: excerpt(raw.body, 600),
    status: parseStatusLine(raw.body),
    claim: parseClaim(raw.body, raw.createdAt, author),
  };
}

// ------------------------------------------------------------------ queries

/** One connection of an issue to read to the end, see `readRest`. */
export interface MoreOf {
  /** Connection field on `Issue`, for example `inverseRelations`. */
  field: string;
  /** GraphQL selection of each node, the same as in the first page. */
  nodes: string;
  /** Operation name of the follow-up query. */
  operation: string;
  /** Plural noun used in the warning when a page cannot be read. */
  what: string;
  /** Nodes per follow-up request; lower it when `nodes` holds a nested connection. */
  first?: number;
}

/** The connections `fetchProgram` reads to the end. */
const MORE = {
  inverseRelations: {
    field: "inverseRelations",
    nodes: "type issue { identifier state { type } }",
    operation: "MoreRelations",
    what: "relations",
  },
  labels: { field: "labels", nodes: "name parent { name }", operation: "MoreLabels", what: "labels" },
  attachments: { field: "attachments", nodes: "title url", operation: "MoreAttachments", what: "attachments" },
  comments: {
    field: "comments",
    nodes: "id createdAt body user { name }",
    operation: "MoreComments",
    what: "comments",
  },
} satisfies Record<string, MoreOf>;
const MORE_QUERY = (m: MoreOf) => /* GraphQL */ `
  query ${m.operation}($id: String!, $after: String) {
    issue(id: $id) {
      ${m.field}(first: ${m.first ?? MORE_PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${m.nodes} } }
    }
  }`;

const FIELDS = (delegate: boolean) => /* GraphQL */ `
  fragment F on Issue {
    id identifier title url description createdAt updatedAt startedAt completedAt canceledAt
    state { name type }
    assignee { name }
    ${delegate ? "delegate { name }" : ""}
    parent { identifier }
    labels(first: 25) { pageInfo { hasNextPage endCursor } nodes { ${MORE.labels.nodes} } }
    attachments(first: 25) { pageInfo { hasNextPage endCursor } nodes { ${MORE.attachments.nodes} } }
    inverseRelations(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${MORE.inverseRelations.nodes} } }
  }
`;
const ROOT_QUERY = (d: boolean) => `${FIELDS(d)} query Root($id: String!) { issue(id: $id) { ...F } }`;
const CHILDREN_QUERY = (d: boolean) => `${FIELDS(d)}
  query Children($parents: [ID!], $after: String) {
    issues(first: 50, after: $after, filter: { parent: { id: { in: $parents } } }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...F }
    }
  }`;
const COMMENTS_QUERY = /* GraphQL */ `
  query Comments($ids: [ID!]) {
    issues(first: 50, filter: { id: { in: $ids } }) {
      nodes { identifier comments(first: ${MAX_COMMENTS}) { pageInfo { hasNextPage endCursor } nodes { ${MORE.comments.nodes} } } }
    }
  }`;

export interface LinearRequestOptions {
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** One GraphQL request to Linear; every failure becomes a LinearError that never quotes the key. */
export async function gql<T>(opts: LinearRequestOptions, query: string, variables: object): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const res = await doFetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opts.apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    throw new LinearError(`Linear API unreachable: ${networkReason(err, timeoutMs)}`, true);
  });
  if (res.status === 401) throw new LinearError("Linear rejected the API key (HTTP 401); check LINEAR_API_KEY", true);
  // GraphQL validation errors come back with HTTP 400 and a JSON body worth reporting.
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new LinearError(`Linear API: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!res.ok) throw new LinearError(`Linear API HTTP ${res.status}`, true);
  if (!json.data) throw new LinearError("Linear API: empty response");
  return json.data;
}

/** "no answer within 30 s" for a timeout or abort, else the underlying message. */
export function networkReason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  return err instanceof Error ? err.message : String(err);
}

const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => xs.slice(k * n, k * n + n));
const CLOSED = new Set(["completed", "canceled"]);

/** Comments matter only where an agent may be working: claims and status lines. */
const isCandidate = (i: Issue, rootId: string) =>
  i.id !== rootId && !CLOSED.has(i.statusType) && (i.agentPhase !== null || i.statusType === "started");

/** Every comment of `issues`, newest first per issue. */
async function readComments(opts: LinearRequestOptions, issues: Issue[], warnings: string[]): Promise<Comment[]> {
  const comments: Comment[] = [];
  for (const batch of chunks(
    issues.map((i) => i.uuid),
    COMMENT_BATCH,
  )) {
    const data = await gql<{ issues: { nodes: { identifier: string; comments: Connection<RawComment> }[] } }>(
      opts,
      COMMENTS_QUERY,
      { ids: batch },
    );
    for (const n of data.issues.nodes) {
      await readRest(opts, n.identifier, MORE.comments, n.comments, warnings);
      for (const c of n.comments.nodes) comments.push(normalizeComment(c, n.identifier));
    }
  }
  return comments;
}

/**
 * Checks one ticket against its current ancestry, independent of a cached
 * program. The first query follows as many levels as the whole program read;
 * deeper ancestry is followed in bounded batches without reading the ticket again.
 * A foreign or missing ticket returns null; a failed read remains an error.
 */
export async function fetchProgramIssue(opts: FetchProgramOptions, ticket: string): Promise<Issue | null> {
  const ancestry = (depth: number): string => `identifier${depth > 0 ? ` parent { ${ancestry(depth - 1)} }` : ""}`;
  const query = `${FIELDS(false)} query ProgramIssue($id: String!) {
    issue(id: $id) { ...F parent { ${ancestry(MAX_DEPTH - 1)} } }
  }`;
  type Ancestor = { identifier: string; parent?: Ancestor | null };
  const { issue } = await gql<{ issue: (RawIssue & { parent: Ancestor | null }) | null }>(opts, query, {
    id: ticket,
  }).catch((err: unknown) => {
    if (err instanceof LinearError && /entity not found/i.test(err.message)) return { issue: null };
    throw err;
  });
  if (!issue) return null;
  let belongs = issue.identifier === opts.rootId;
  let parent = issue.parent;
  const seen = new Set([issue.identifier]);
  while (!belongs && parent) {
    if (seen.has(parent.identifier)) return null;
    seen.add(parent.identifier);
    belongs = parent.identifier === opts.rootId;
    if (belongs) break;
    if (parent.parent === undefined) {
      const data = await gql<{ issue: Ancestor | null }>(
        opts,
        `query ProgramAncestors($id: String!) { issue(id: $id) { ${ancestry(MAX_DEPTH)} } }`,
        { id: parent.identifier },
      );
      parent = data.issue?.parent ?? null;
    } else parent = parent.parent;
  }
  if (!belongs) return null;
  // The snapshot is marked for a whole read by the caller; complete any
  // connections here so the ticket's labels and blockers are usable meanwhile.
  const warnings: string[] = [];
  for (const field of ["inverseRelations", "labels", "attachments"] as const)
    await readRest(opts, issue.identifier, MORE[field], issue[field] as Connection<unknown>, warnings);
  return normalizeIssue(issue, opts.labels);
}

/** Reads the whole program under `rootId` plus the comments of every ticket an agent may hold. */
export async function fetchProgram(opts: FetchProgramOptions): Promise<ProgramData> {
  try {
    return await fetchTree(opts, true);
  } catch (err) {
    // `delegate` is newer than the rest of the schema; retry without it if rejected.
    if (err instanceof LinearError && /delegate/i.test(err.message)) return fetchTree(opts, false);
    throw err;
  }
}

async function fetchTree(opts: FetchProgramOptions, delegate: boolean): Promise<ProgramData> {
  const root = (await gql<{ issue: RawIssue | null }>(opts, ROOT_QUERY(delegate), { id: opts.rootId })).issue;
  if (!root) throw new LinearError(`Linear: program root ${opts.rootId} not found`);

  const all: RawIssue[] = [root];
  const warnings: string[] = [];
  let parents = [root.id];
  for (let depth = 0; depth < MAX_DEPTH && parents.length; depth++) {
    const next: string[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawIssue[] } } =
        await gql(opts, CHILDREN_QUERY(delegate), { parents, after });
      all.push(...data.issues.nodes);
      next.push(...data.issues.nodes.map((n) => n.id));
      const { hasNextPage, endCursor } = data.issues.pageInfo;
      if (!hasNextPage) break;
      if (!endCursor || endCursor === after) {
        warnings.push(`issues at depth ${depth + 1}: Linear did not advance to the next page; the rest are ignored`);
        break;
      }
      after = endCursor;
    }
    parents = next;
  }
  if (parents.length) warnings.push(`the program is deeper than ${MAX_DEPTH} levels; deeper issues are ignored`);
  for (const r of all)
    for (const field of ["inverseRelations", "labels", "attachments"] as const)
      await readRest(opts, r.identifier, MORE[field], r[field] as Connection<unknown>, warnings);

  const issues = all.map((r) => normalizeIssue(r, opts.labels));
  const comments = await readComments(
    opts,
    issues.filter((i) => isCandidate(i, root.identifier)),
    warnings,
  );

  return {
    rootId: root.identifier,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    issues: issues.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    comments: comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warnings,
  };
}

/**
 * Appends the remaining pages of one connection of issue `identifier` to `conn`,
 * until Linear reports no next page; `conn.pageInfo` then describes the last
 * page read. When Linear answers a page with an error, reading stops there with
 * a warning and what was read is kept. When Linear cannot be reached at all, the
 * error is thrown, as for every other request of the read.
 */
export async function readRest<T>(
  opts: LinearRequestOptions,
  identifier: string,
  more: MoreOf,
  conn: Connection<T>,
  warnings: string[],
): Promise<void> {
  while (conn.pageInfo?.hasNextPage) {
    const after = conn.pageInfo.endCursor;
    try {
      if (!after) throw new LinearError("Linear gave no cursor for the next page");
      const data = await gql<{ issue: Record<string, Connection<T> | undefined> | null }>(opts, MORE_QUERY(more), {
        id: identifier,
        after,
      });
      const page = data.issue?.[more.field];
      if (!page) throw new LinearError(`Linear: issue ${identifier} not found`);
      conn.nodes.push(...page.nodes);
      conn.pageInfo = page.pageInfo;
      if (page.pageInfo?.hasNextPage && page.pageInfo.endCursor === after)
        throw new LinearError("Linear did not advance to a next page");
    } catch (err) {
      if (!(err instanceof LinearError) || err.transport) throw err;
      warnings.push(`${identifier}: could not read all its ${more.what} (${err.message}); some may be missing`);
      return;
    }
  }
}

// ------------------------------------------------------------------ incremental reads

const CHANGED_QUERY = (d: boolean) => `${FIELDS(d)}
  query Changed($filter: IssueFilter, $after: String) {
    issues(first: 50, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ...F }
    }
  }`;
const CHANGED_COMMENTS_QUERY = /* GraphQL */ `
  query ChangedComments($filter: CommentFilter, $after: String) {
    comments(first: ${MORE_PAGE}, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ${MORE.comments.nodes} issue { identifier } }
    }
  }`;
/** Ids per `in` filter of an incremental read: a 300-ticket program takes two requests. */
const IDS_PER_FILTER = 200;
/** Pages read per incremental query; a change touching more is a full read's job. */
const MAX_CHANGED_PAGES = 20;

export interface FetchChangesOptions extends FetchProgramOptions {
  /** The last reading, whose tickets are read again only when they changed. */
  previous: ProgramData;
  /** Tickets and comments updated after this instant (ISO) are read again; give some overlap. */
  since: string;
  /** Linear ids (uuids) of tickets a webhook named: read again whatever their update time. */
  touched?: string[];
}

/** An incremental read stopped short: a full read follows instead. */
class IncompleteChanges extends Error {}

/** Every page of one `issues` or `comments` query; throws `IncompleteChanges` when they cannot all be read. */
async function readPages<T>(
  opts: LinearRequestOptions,
  query: string,
  field: "issues" | "comments",
  filter: object,
): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  for (let page = 0; ; page++) {
    const data: Record<string, Connection<T>> = await gql(opts, query, { filter, after });
    const conn = data[field];
    if (!conn) break;
    nodes.push(...conn.nodes);
    const next = conn.pageInfo;
    if (!next?.hasNextPage) break;
    if (!next.endCursor || next.endCursor === after || page + 1 >= MAX_CHANGED_PAGES) throw new IncompleteChanges();
    after = next.endCursor;
  }
  return nodes;
}

/**
 * Reads what changed in a program since the last reading and returns the
 * whole program again, as `fetchProgram` would: the tickets of the program
 * updated after `since`, the `touched` ones, new tickets under any of them
 * (any depth), and the comments updated since on the tickets an agent may
 * hold (every comment of a ticket that just became one). A few requests
 * instead of one per level and page of the whole tree. Tickets deleted or
 * moved out of Linear's reach stay until the next full read. When the changes
 * are too many to read in a few pages, the program is read whole instead.
 */
export async function fetchProgramChanges(opts: FetchChangesOptions): Promise<ProgramData> {
  try {
    try {
      return await readChanges(opts, true);
    } catch (err) {
      if (err instanceof LinearError && /delegate/i.test(err.message)) return await readChanges(opts, false);
      throw err;
    }
  } catch (err) {
    if (err instanceof IncompleteChanges) return fetchProgram(opts);
    throw err;
  }
}

async function readChanges(opts: FetchChangesOptions, delegate: boolean): Promise<ProgramData> {
  const { previous, since } = opts;
  const warnings: string[] = [];
  const known = previous.issues.map((i) => i.uuid);
  const isKnown = new Set(known);
  const raws: RawIssue[] = [];
  const read = (filter: object) => readPages<RawIssue>(opts, CHANGED_QUERY(delegate), "issues", filter);

  // Tickets of the program updated since, and new tickets under them.
  for (const ids of chunks(known, IDS_PER_FILTER))
    raws.push(
      ...(await read({
        updatedAt: { gt: since },
        or: [{ id: { in: ids } }, { parent: { id: { in: ids } } }],
      })),
    );
  const touched = [...new Set(opts.touched ?? [])].filter((id) => !raws.some((r) => r.id === id));
  // A webhook may name a ticket outside the program (the new parent of one moved out): only
  // tickets of the program, or now under one of its tickets, are kept.
  const inProgram = new Set([...previous.issues.map((i) => i.id), ...raws.map((r) => r.identifier)]);
  for (const ids of chunks(touched, IDS_PER_FILTER))
    for (const r of await read({ id: { in: ids } }))
      if (isKnown.has(r.id) || (r.parent && inProgram.has(r.parent.identifier))) raws.push(r);
  // A ticket new to the program brings its own subtree, read whole.
  const seen = new Set([...known, ...raws.map((r) => r.id)]);
  let fresh = raws.filter((r) => !isKnown.has(r.id)).map((r) => r.id);
  for (let depth = 0; depth < MAX_DEPTH && fresh.length; depth++) {
    const children: RawIssue[] = [];
    for (const ids of chunks(fresh, IDS_PER_FILTER)) children.push(...(await read({ parent: { id: { in: ids } } })));
    const added = children.filter((c) => !seen.has(c.id));
    for (const c of added) seen.add(c.id);
    raws.push(...added);
    fresh = added.map((c) => c.id);
  }
  for (const r of raws)
    for (const field of ["inverseRelations", "labels", "attachments"] as const)
      await readRest(opts, r.identifier, MORE[field], r[field] as Connection<unknown>, warnings);

  const byUuid = new Map(previous.issues.map((i) => [i.uuid, i]));
  for (const r of raws) byUuid.set(r.id, normalizeIssue(r, opts.labels));
  const issues = [...byUuid.values()];

  // Comments: updated since on the tickets that already were candidates, every one on the new candidates.
  const wasCandidate = new Set(previous.issues.filter((i) => isCandidate(i, previous.rootId)).map((i) => i.uuid));
  const candidates = issues.filter((i) => isCandidate(i, previous.rootId));
  const comments = new Map(
    previous.comments.filter((c) => candidates.some((i) => i.id === c.issueId)).map((c) => [c.id, c]),
  );
  const kept = candidates.filter((i) => wasCandidate.has(i.uuid));
  for (const ids of chunks(
    kept.map((i) => i.uuid),
    IDS_PER_FILTER,
  )) {
    const changed = await readPages<RawComment & { issue: { identifier: string } | null }>(
      opts,
      CHANGED_COMMENTS_QUERY,
      "comments",
      { updatedAt: { gt: since }, issue: { id: { in: ids } } },
    );
    for (const c of changed) if (c.issue) comments.set(c.id, normalizeComment(c, c.issue.identifier));
  }
  for (const c of await readComments(
    opts,
    candidates.filter((i) => !wasCandidate.has(i.uuid)),
    warnings,
  ))
    comments.set(c.id, c);

  return {
    rootId: previous.rootId,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    issues: issues.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    comments: [...comments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // The full read's caps still hold until the next one.
    warnings: [...new Set([...previous.warnings, ...warnings])],
  };
}
