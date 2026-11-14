import type { OttoCompleteness, OttoOrphan, OttoResource, OttoTask } from "@armada/core";
import { isRecord } from "@armada/core";
import { relativeAge } from "./relative-time.ts";

/**
 * The Otto page (#1303): a read-only view of what the server observed for one repository (`/api/v1/otto/*`, #1283).
 * Nothing here guesses: a value the server reports as unknown stays unknown, with when it was last observed, and a
 * value the API does not report is said to be missing, never shown as an empty "nothing".
 */
export type OttoSummary = {
  openPrCount: number | null;
  orphanCount: number | null;
  ownershipCompleteness: string;
  fleetCoverage: string;
  limitations: string[];
};

export type OttoSnapshot = {
  repository: string | null;
  /** The last repository listing the server observed (null: never observed). */
  observedAt: string | null;
  githubCompleteness: OttoCompleteness;
  summary: OttoSummary | null;
  tasks: OttoTask[];
  resources: OttoResource[];
  orphans: OttoOrphan[];
  /** A list longer than the pages read here: what is shown is a part, said so on the page. */
  truncated: boolean;
};

export type OttoRead =
  | { state: "ready"; snapshot: OttoSnapshot }
  | { state: "not-observed" | "unauthorized" | "unavailable" | "unreachable" | "malformed" };

const PAGE_LIMIT = 100;
/** Bounded reading: at most this many pages per list, then the page says the list was cut. */
export const MAX_PAGES = 5;
/** One deadline for the whole read: every view and page together, so a slow server cannot hold a render long. */
const TIMEOUT_MS = 10_000;

type Page = {
  items: unknown[];
  observedAt: string | null;
  completeness: unknown;
  githubCompleteness?: unknown;
  nextCursor: string | null;
};
type Get = (view: string, params: Record<string, string>) => Promise<Page>;

class ReadFailure extends Error {
  constructor(readonly state: Exclude<OttoRead["state"], "ready">) {
    super(state);
  }
}

/** Reads every Otto view the page needs, as the signed-in member, from the Armada server's origin. */
export async function readOtto(options: {
  serverUrl: string;
  token: string;
  orgId: string;
  fetch?: typeof fetch;
}): Promise<OttoRead> {
  let origin: string;
  try {
    const url = new URL(options.serverUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      return { state: "unreachable" };
    origin = url.origin;
  } catch {
    return { state: "unreachable" };
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const get: Get = async (view, params) => {
    const url = new URL(`/api/v1/otto/${view}`, origin);
    url.searchParams.set("org_id", options.orgId);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response, body: unknown;
    try {
      response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { authorization: `Bearer ${options.token}` },
        redirect: "error",
        cache: "no-store",
        signal,
      });
      body = await response.json().catch(() => null);
      signal.throwIfAborted();
    } catch {
      throw new ReadFailure(signal.aborted ? "unavailable" : "unreachable");
    }
    // Without Otto the server mounts no Otto route: the control API answers a GET with 405, an unknown path with 404.
    if (response.status === 404 || response.status === 405) throw new ReadFailure("not-observed");
    if (response.status === 401) throw new ReadFailure("unauthorized");
    if (!response.ok) throw new ReadFailure("unavailable");
    const page = parsePage(body);
    if (!page) throw new ReadFailure("malformed");
    return page;
  };
  try {
    const [summary, tasks, resources, orphans, facts] = await Promise.all([
      get("summary", { limit: "1" }),
      readAll(get, "tasks"),
      readAll(get, "resources"),
      readAll(get, "orphans"),
      get("facts", { limit: "1" }),
    ]);
    const parsedSummary = summary.items.length === 0 ? null : parseSummary(summary.items[0]);
    const parsedTasks = tasks.items.map(parseTask);
    const parsedResources = resources.items.map(parseResource);
    const parsedOrphans = orphans.items.map(parseOrphan);
    if (
      parsedSummary === undefined ||
      !parsedTasks.every(isDefined) ||
      !parsedResources.every(isDefined) ||
      !parsedOrphans.every(isDefined)
    )
      return { state: "malformed" };
    const fact = facts.items[0];
    return {
      state: "ready",
      snapshot: {
        repository: isRecord(fact) && typeof fact.repository === "string" ? fact.repository : null,
        observedAt: summary.observedAt,
        githubCompleteness: completeness(summary.githubCompleteness ?? summary.completeness),
        summary: parsedSummary,
        tasks: parsedTasks,
        resources: parsedResources,
        orphans: parsedOrphans,
        truncated: tasks.truncated || resources.truncated || orphans.truncated,
      },
    };
  } catch (error) {
    if (error instanceof ReadFailure) return { state: error.state };
    throw error;
  }
}

async function readAll(get: Get, view: string) {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: Page = await get(view, { limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) return { items, truncated: false };
  }
  return { items, truncated: true };
}

function parsePage(value: unknown): Page | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (value.observedAt !== null && !isDate(value.observedAt)) return null;
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") return null;
  return {
    items: value.items,
    observedAt: value.observedAt,
    completeness: value.completeness,
    githubCompleteness: value.githubCompleteness,
    nextCursor: value.nextCursor,
  };
}

function completeness(value: unknown): OttoCompleteness {
  return value === "complete" || value === "partial" ? value : "unknown";
}

const count = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

function parseSummary(value: unknown): OttoSummary | undefined {
  if (!isRecord(value) || !count(value.openPrCount) || !count(value.orphanCount)) return undefined;
  return {
    openPrCount: value.openPrCount as number | null,
    orphanCount: value.orphanCount as number | null,
    ownershipCompleteness: typeof value.ownershipCompleteness === "string" ? value.ownershipCompleteness : "unknown",
    fleetCoverage: typeof value.fleetCoverage === "string" ? value.fleetCoverage : "unknown",
    limitations: Array.isArray(value.limitations)
      ? value.limitations.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseTask(value: unknown): OttoTask | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.issueNumber) ||
    typeof value.title !== "string" ||
    typeof value.factId !== "string"
  )
    return undefined;
  return {
    issueNumber: value.issueNumber as number,
    title: value.title,
    state: value.state === "open" ? "open" : "unknown",
    factId: value.factId,
  };
}

function parseResource(value: unknown): OttoResource | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "pr" && value.kind !== "sandbox") ||
    typeof value.externalId !== "string" ||
    (value.taskIssue !== null && !Number.isSafeInteger(value.taskIssue)) ||
    !isRecord(value.owner) ||
    typeof value.reason !== "string" ||
    (value.observedAt !== null && !isDate(value.observedAt))
  )
    return undefined;
  const state = value.owner.state;
  return {
    kind: value.kind,
    externalId: value.externalId,
    taskIssue: value.taskIssue as number | null,
    owner: {
      state: state === "owned" || state === "orphan" ? state : "unknown",
      userId: typeof value.owner.userId === "string" ? value.owner.userId : null,
    },
    reason: value.reason,
    observedAt: value.observedAt,
    evidence: isRecord(value.evidence) ? value.evidence : {},
  };
}

function parseOrphan(value: unknown): OttoOrphan | undefined {
  if (!isRecord(value) || typeof value.reason !== "string" || typeof value.day !== "string") return undefined;
  const resource = parseResource(value.resource);
  if (!resource) return undefined;
  return { resource, state: value.state === "orphan" ? "orphan" : "unknown", reason: value.reason, day: value.day };
}

/** The row key of a resource on the page and in `?item=`. */
export const resourceKey = (resource: Pick<OttoResource, "kind" | "externalId">) =>
  `${resource.kind}:${resource.externalId}`;
/** The server names a task whose issue it never observed `Issue #N`: that is not a title, so it is not shown as one. */
export function taskTitle(task: Pick<OttoTask, "issueNumber" | "title">): string | null {
  const title = task.title.trim();
  return title && title !== `Issue #${task.issueNumber}` ? title : null;
}
export const taskKey = (task: Pick<OttoTask, "issueNumber">) => `task:${task.issueNumber}`;

export type OttoTreeNode = { task: OttoTask; resources: OttoResource[] };

/**
 * Who owns what: each task in issue order with the resources the server linked to it, then the resources linked to
 * no task. A resource whose task is not in the task list is not attached to a guessed parent: it stays unlinked.
 */
export function ottoTree(tasks: readonly OttoTask[], resources: readonly OttoResource[]) {
  const ordered = [...tasks].sort((a, b) => a.issueNumber - b.issueNumber);
  const known = new Set(ordered.map((task) => task.issueNumber));
  const byKind = (a: OttoResource, b: OttoResource) =>
    a.kind.localeCompare(b.kind) || a.externalId.localeCompare(b.externalId, "en", { numeric: true });
  const nodes: OttoTreeNode[] = ordered.map((task) => ({
    task,
    resources: resources.filter((resource) => resource.taskIssue === task.issueNumber).sort(byKind),
  }));
  const unlinked = resources
    .filter((resource) => resource.taskIssue === null || !known.has(resource.taskIssue))
    .sort(byKind);
  return { nodes, unlinked };
}

/** When the newest evidence about a task was observed: its linked resources, else the repository listing. */
export function taskObservedAt(node: OttoTreeNode, fallback: string | null): string | null {
  const times = node.resources.flatMap((resource) => (resource.observedAt ? [resource.observedAt] : []));
  return times.sort().at(-1) ?? fallback;
}

/** "Unknown · last observed 5 min ago", or "never observed": an unknown is never shown as an empty space. */
export function unknownLabel(observedAt: string | null, now: number): string {
  const age = observedAt ? relativeAge(observedAt, now) : null;
  return age ? `Unknown · last observed ${age}` : "Unknown · never observed";
}

/** A count the server could not establish is unknown, never zero. */
export function countLabel(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "Unknown";
}

export type OwnerLook = { tone: "success" | "warning" | "neutral"; label: string };

/** A row's short owner state; the row's second line and its panel say when the resource was last observed. */
export function ownerLook(resource: OttoResource, viewerId: string): OwnerLook {
  if (resource.owner.state === "orphan") return { tone: "warning", label: "Orphan" };
  if (resource.owner.state === "owned")
    return {
      tone: "success",
      label: resource.owner.userId === viewerId ? "Owned by you" : "Owned by a member",
    };
  return { tone: "neutral", label: "Owner unknown" };
}

const REASONS: Record<string, string> = {
  current_worker_branch_not_observed:
    "The branch a worker currently has checked out is not observed, so no live owner can be confirmed or ruled out.",
  armada_user_owner_task_link_unknown: "An Armada member owns this sandbox; which task it works on is not observed.",
};

/** The server's reason code in plain words; an unknown code is shown as it is rather than dropped. */
export function reasonText(reason: string): string {
  return REASONS[reason] ?? `Reported reason: ${reason}`;
}

export function resourceName(resource: OttoResource): string {
  if (resource.kind === "sandbox") return `Sandbox ${resource.externalId.slice(0, 8)}`;
  const title = typeof resource.evidence.title === "string" ? resource.evidence.title.trim() : "";
  return title ? `#${resource.externalId} ${title}` : `Pull request #${resource.externalId}`;
}

export type PrHead = { repo: string | null; ref: string | null; sha: string | null };

export function prHead(resource: OttoResource): PrHead | null {
  const head = resource.evidence.head;
  if (resource.kind !== "pr" || !isRecord(head)) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { repo: text(head.repo), ref: text(head.ref), sha: text(head.sha) };
}

/** A GitHub link only for a repository name the server reported and a numeric pull request. */
export function pullRequestUrl(repository: string | null, resource: OttoResource): string | null {
  if (!repository || resource.kind !== "pr" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
  if (!/^[1-9]\d*$/.test(resource.externalId)) return null;
  return `https://github.com/${repository}/pull/${resource.externalId}`;
}

/** Today's orphans split as the server reports them: confirmed, and candidates whose ownership is unknown. */
export function orphansOfDay(orphans: readonly OttoOrphan[]) {
  return {
    confirmed: orphans.filter((orphan) => orphan.state === "orphan"),
    candidates: orphans.filter((orphan) => orphan.state !== "orphan"),
    day: orphans[0]?.day ?? null,
  };
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
