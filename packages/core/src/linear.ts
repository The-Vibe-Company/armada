// Linear read adapter: walks the program tree from its root issue at any depth,
// then reads the comments of the tickets an agent may hold. The normalizers are
// pure and exported so they can be tested on recorded responses.
import type { AgentClaim, AgentPhase, Blocker, Comment, Issue, LabelPhase, ProgramData, StatusType } from "./types.ts";
import { LABEL_PHASES } from "./types.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const MAX_DEPTH = 8;
const MAX_PAGES = 20;
// Linear rejects queries above a complexity budget (roughly nodes requested,
// multiplied through nested connections). Caps stay small and every cap that
// is hit becomes a warning instead of silently truncating.
const COMMENT_BATCH = 25;
const MAX_COMMENTS = 100;
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
}

// ------------------------------------------------------------------ parsers

const PHASES: AgentPhase[] = [...LABEL_PHASES, "released", "merged"];
/** Older status-line words mapped onto the protocol. */
const LEGACY: Record<string, AgentPhase> = { "handed-back": "ready-to-merge", "ci-fixing": "shipping" };

const firstLine = (body: string) => (body.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`]/g, "");

/** First line "Agent status: <phase> — <summary>" (em dash, en dash or hyphen). */
export function parseStatusLine(body: string): Comment["status"] {
  const m = firstLine(body).match(/^\s*Agent status\s*:\s*([a-z-]+)\s*(?:[—–-]+\s*(.*))?$/i);
  if (!m?.[1]) return null;
  const raw = m[1].toLowerCase();
  const phase = LEGACY[raw] ?? (raw as AgentPhase);
  return PHASES.includes(phase) ? { phase, summary: (m[2] ?? "").trim() } : null;
}

/** Removes markdown backslash escapes (Linear stores `a_b` as `a\_b`). */
const unescapeMarkdown = (line: string) => line.replace(/\\([!-/:-@[-`{-~])/g, "$1");
/** Emphasis wrapped around a whole value (`x`, **x**, _x_), never marks that belong to it. */
const trimMarks = (v: string) => {
  const t = v.trim();
  return t.match(/^([*_`]+)(.+)\1$/)?.[2]?.trim() ?? t;
};

/**
 * The line "Agent claim — runtime: X · session: Y · branch: Z · started: D".
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
  return {
    runtime: field("runtime"),
    session: field("session"),
    branch: field("branch|branche"),
    startedAt: field("started|démarré|demarre"),
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

/** A Linear connection; `pageInfo.hasNextPage` tells when a fixed read cap truncated it. */
export interface Connection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean };
}

/** Human-readable notes for every connection of `raw` that was cut by a read cap. */
export function truncationWarnings(raw: RawIssue): string[] {
  const cut = (c: Connection<unknown>, what: string) =>
    c.pageInfo?.hasNextPage ? [`${raw.identifier}: more ${what} than Armada reads; some are ignored`] : [];
  return [
    ...cut(raw.inverseRelations, "relations"),
    ...cut(raw.labels, "labels"),
    ...cut(raw.attachments, "attachments"),
  ];
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

const FIELDS = (delegate: boolean) => /* GraphQL */ `
  fragment F on Issue {
    id identifier title url description createdAt updatedAt startedAt completedAt canceledAt
    state { name type }
    assignee { name }
    ${delegate ? "delegate { name }" : ""}
    parent { identifier }
    labels(first: 25) { pageInfo { hasNextPage } nodes { name parent { name } } }
    attachments(first: 25) { pageInfo { hasNextPage } nodes { title url } }
    inverseRelations(first: 50) { pageInfo { hasNextPage } nodes { type issue { identifier state { type } } } }
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
      nodes { identifier comments(first: ${MAX_COMMENTS}) { pageInfo { hasNextPage } nodes { id createdAt body user { name } } } }
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
    throw new LinearError(`Linear API unreachable: ${networkReason(err, timeoutMs)}`);
  });
  if (res.status === 401) throw new LinearError("Linear rejected the API key (HTTP 401); check LINEAR_API_KEY");
  // GraphQL validation errors come back with HTTP 400 and a JSON body worth reporting.
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new LinearError(`Linear API: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!res.ok) throw new LinearError(`Linear API HTTP ${res.status}`);
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
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        warnings.push(`more than ${MAX_PAGES * 50} issues at depth ${depth + 1}; the rest are ignored`);
        break;
      }
      const data: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawIssue[] } } = await gql(
        opts,
        CHILDREN_QUERY(delegate),
        { parents, after },
      );
      all.push(...data.issues.nodes);
      next.push(...data.issues.nodes.map((n) => n.id));
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
    }
    parents = next;
  }
  if (parents.length) warnings.push(`the program is deeper than ${MAX_DEPTH} levels; deeper issues are ignored`);
  for (const r of all) warnings.push(...truncationWarnings(r));

  const issues = all.map((r) => normalizeIssue(r, opts.labels));
  // Comments matter only where an agent may be working: claims and status lines.
  const candidates = issues.filter(
    (i) => i.id !== root.identifier && !CLOSED.has(i.statusType) && (i.agentPhase || i.statusType === "started"),
  );
  const comments: Comment[] = [];
  for (const batch of chunks(
    candidates.map((i) => i.uuid),
    COMMENT_BATCH,
  )) {
    const data = await gql<{ issues: { nodes: { identifier: string; comments: Connection<RawComment> }[] } }>(
      opts,
      COMMENTS_QUERY,
      { ids: batch },
    );
    for (const n of data.issues.nodes) {
      for (const c of n.comments.nodes) comments.push(normalizeComment(c, n.identifier));
      if (n.comments.pageInfo?.hasNextPage)
        warnings.push(`${n.identifier}: more than ${MAX_COMMENTS} comments; its phase and claim may be out of date`);
    }
  }

  return {
    rootId: root.identifier,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    issues: issues.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    comments: comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warnings,
  };
}
