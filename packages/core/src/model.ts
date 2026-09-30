// The program tree and the rules every view shares: which tickets are closed,
// started, blocked or on the frontier, and which direct children of the root
// are specs. Nothing is hardcoded to a spec count, a depth or a team key.
import type { Issue, StatusType } from "./types.ts";

const CLOSED: StatusType[] = ["completed", "canceled"];
const NOT_STARTED: StatusType[] = ["triage", "backlog", "unstarted"];

export const isDone = (i: { statusType: StatusType }) => i.statusType === "completed";
export const isClosed = (i: { statusType: StatusType }) => CLOSED.includes(i.statusType);
export const isStarted = (i: { statusType: StatusType }) => i.statusType === "started";
export const isNotStarted = (i: { statusType: StatusType }) => NOT_STARTED.includes(i.statusType);

/** Spec convention: a direct child of the root titled "Spec N/M — Name" (em dash, en dash or hyphen). */
export const SPEC_TITLE = /^Spec\s+(\d+)\s*\/\s*(\d+)\s*[—–-]\s*(.+)$/;

export type NodeState = "done" | "canceled" | "active" | "frontier" | "blocked";

export interface Spec {
  issue: Issue;
  ordinal: number;
  name: string;
}

export interface Model {
  root: Issue;
  byId: Map<string, Issue>;
  childrenOf: Map<string, Issue[]>;
  /** Every descendant of the root, any depth. */
  program: Issue[];
  specs: Spec[];
  /** Nearest spec ancestor of an issue (or the issue itself). */
  specOf: (id: string) => Spec | null;
  /** Leaf = a ticket someone can work on: no sub-issues and not a spec. */
  isLeaf: (i: Issue) => boolean;
  /** Blocked-by tickets that are not closed. */
  openBlockersOf: (i: Issue) => string[];
  stateOf: (i: Issue) => NodeState;
}

export function buildModel(issues: Issue[], rootId: string): Model {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const root = byId.get(rootId);
  if (!root) throw new Error(`program root ${rootId} is not among the issues read`);

  const childrenOf = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.parentId || !byId.has(i.parentId)) continue;
    childrenOf.set(i.parentId, [...(childrenOf.get(i.parentId) ?? []), i]);
  }
  const program: Issue[] = [];
  const walk = (id: string, seen: Set<string>) => {
    for (const c of childrenOf.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      program.push(c);
      walk(c.id, seen);
    }
  };
  walk(root.id, new Set([root.id]));

  const specs: Spec[] = (childrenOf.get(root.id) ?? [])
    .flatMap((issue) => {
      const m = issue.title.trim().match(SPEC_TITLE);
      return m?.[1] && m[3] ? [{ issue, ordinal: Number(m[1]), name: m[3].trim() }] : [];
    })
    .sort((a, b) => a.ordinal - b.ordinal || a.issue.createdAt.localeCompare(b.issue.createdAt));
  const specById = new Map(specs.map((s) => [s.issue.id, s]));

  const specOf = (id: string): Spec | null => {
    const seen = new Set<string>();
    for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      const s = specById.get(cur.id);
      if (s) return s;
    }
    return null;
  };

  const isLeaf = (i: Issue) => !childrenOf.get(i.id)?.length && !specById.has(i.id);

  // A blocker inside the tree is judged by its current row; one outside the
  // tree by the state recorded on the relation.
  const openBlockersOf = (i: Issue) => i.blockedBy.filter((b) => !isClosed(byId.get(b.id) ?? b)).map((b) => b.id);

  const stateOf = (i: Issue): NodeState => {
    if (isDone(i)) return "done";
    if (i.statusType === "canceled") return "canceled";
    if (isStarted(i)) return "active";
    return openBlockersOf(i).length ? "blocked" : "frontier";
  };

  return { root, byId, childrenOf, program, specs, specOf, isLeaf, openBlockersOf, stateOf };
}

/** Longest-path wave index over blocked-by edges inside `nodes` (cycle-safe). */
export function longestPathLevels(nodes: Issue[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const blockers = (byId.get(id)?.blockedBy ?? []).map((b) => b.id).filter((b) => byId.has(b));
    const l = blockers.length ? Math.max(...blockers.map(visit)) + 1 : 0;
    visiting.delete(id);
    level.set(id, l);
    return l;
  };
  for (const n of nodes) visit(n.id);
  return level;
}

/** Longest chain of remaining (not closed) work among the direct children of `parentId`. */
export function criticalPath(m: Model, parentId: string): Issue[] {
  const nodes = m.childrenOf.get(parentId) ?? [];
  const level = longestPathLevels(nodes);
  const remaining = nodes.filter((n) => !isClosed(n));
  const remIds = new Set(remaining.map((n) => n.id));
  const len = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const order = [...remaining].sort((a, b) => (level.get(a.id) ?? 0) - (level.get(b.id) ?? 0));
  for (const n of order) {
    let best = 0;
    let bestPrev: string | null = null;
    for (const { id } of n.blockedBy) {
      if (!remIds.has(id)) continue;
      const l = len.get(id) ?? 0;
      if (l > best) {
        best = l;
        bestPrev = id;
      }
    }
    len.set(n.id, best + 1);
    prev.set(n.id, bestPrev);
  }
  let tail: string | null = null;
  let tailLen = 0;
  for (const [id, l] of len)
    if (l > tailLen || (l === tailLen && tail && id > tail)) {
      tail = id;
      tailLen = l;
    }
  if (tailLen < 2) return [];
  const path: Issue[] = [];
  for (let cur = tail; cur; cur = prev.get(cur) ?? null) {
    const issue = m.byId.get(cur);
    if (issue) path.unshift(issue);
  }
  return path;
}

/** Union of the critical paths under every issue that has sub-issues. */
export function criticalIds(m: Model): Set<string> {
  const out = new Set<string>();
  for (const parent of m.childrenOf.keys()) for (const i of criticalPath(m, parent)) out.add(i.id);
  return out;
}
