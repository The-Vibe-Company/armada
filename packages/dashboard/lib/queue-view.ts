// The merge queue as a project's page shows it (THE-1103): each entry in the
// drain's order with what it waits on, and whether a Merge press on a pull
// request already queued it or asked the coordinator. Read from the polled
// overview (Postgres only: no GitHub read); core orders the entries
// (`shownQueue`).
import type { ProjectOverview, ShownQueueEntry } from "@armada/core/read";

export type QueueRowState = "merging" | "queued" | "retry" | "refused";

export interface QueueRow {
  id: number;
  pr: number;
  ticket: string | null;
  /** Its pull request's title and link in the stored reading, when it is still open there. */
  title: string | null;
  url: string | null;
  state: QueueRowState;
  /** What the drain is doing, why it retries, or why it was refused. */
  detail: string | null;
  /** What a merging entry waits for, when the drain said so ("the checks on the updated head of #12"). */
  waiting: string | null;
  /** Its place in the drain's order; null once refused. */
  position: number | null;
  queuedBy: string;
  /** A retry's next attempt. */
  notBefore: string | null;
}

/** How the drain words a wait (core's merge: "Waiting: <reason>…"). */
const WAITING = /^Waiting: (.+?)…?$/;

const stateOf = (e: ShownQueueEntry, now: number): QueueRowState =>
  e.state === "merging"
    ? "merging"
    : e.state === "refused"
      ? "refused"
      : e.notBefore && Date.parse(e.notBefore) > now
        ? "retry"
        : "queued";

/** The rows of a project's merge queue; empty when nothing is queued or was refused lately. */
export function queueRows(project: Pick<ProjectOverview, "queue" | "pullRequests">, now: number): QueueRow[] {
  let position = 0;
  return (project.queue ?? [])
    .filter((e) => e.state === "queued" || e.state === "merging" || e.state === "refused")
    .map((e) => {
      const pr = project.pullRequests?.find((p) => p.number === e.pr);
      const state = stateOf(e, now);
      return {
        id: e.id,
        pr: e.pr,
        ticket: e.ticket,
        title: pr?.title ?? null,
        url: pr?.url ?? null,
        state,
        detail: e.detail,
        waiting: (state === "merging" && e.detail?.match(WAITING)?.[1]) || null,
        position: state === "refused" ? null : ++position,
        queuedBy: e.queuedBy,
        notBefore: state === "retry" ? e.notBefore : null,
      };
    });
}

/** What a Merge press on this pull request already did: queued it, or asked the coordinator. */
export interface MergeAsked {
  queued: boolean;
  author: string | null;
  at: string;
}

export function mergeAsked(project: Pick<ProjectOverview, "queue" | "requests"> | undefined, pr: number | null) {
  if (!project || pr === null) return null;
  const entry = project.queue?.find((e) => e.pr === pr && (e.state === "queued" || e.state === "merging"));
  if (entry) return { queued: true, author: entry.queuedBy, at: entry.queuedAt } satisfies MergeAsked;
  const request = project.requests.find((r) => r.kind === "merge-request" && r.request?.pr === pr);
  return request ? ({ queued: false, author: request.author, at: request.createdAt } satisfies MergeAsked) : null;
}
