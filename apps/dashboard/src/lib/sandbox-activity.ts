import type { SandboxStatus } from "@armada/core/contract";
import type { SandboxListMetadata } from "./sandbox-access.ts";
import { sandboxAttention } from "./sandbox-attention";

/** Project the same attention as detail, without pretending unread turns have finished. */
export function sandboxListAttention(row: SandboxListMetadata, now: Date) {
  return sandboxAttention(
    {
      id: row.id,
      status: row.status,
      task_outcome: row.taskOutcome ?? null,
      ...(row.pullRequests ? { pull_requests: row.pullRequests } : {}),
      preservation_note: row.preservationNote ?? null,
      ...(row.expiresAt ? { expires_at: row.expiresAt } : {}),
      status_reason: row.statusMessage ?? null,
    },
    null,
    now,
  ).attention;
}

export type SandboxTurnObservation = Pick<SandboxStatus, "status" | "settled" | "prompt" | "expiresAt">;

function beforeDeadline(expiresAt: string | null, now: Date) {
  return expiresAt === null || Date.parse(expiresAt) > now.getTime();
}

export function isWaitingCandidate(row: SandboxListMetadata, viewerId: string, now: Date) {
  return row.ownerId === viewerId && row.canOpen && row.status === "ready" && beforeDeadline(row.expiresAt, now);
}

function sandboxNeedsViewer(
  row: SandboxListMetadata,
  viewerId: string,
  observation: SandboxTurnObservation | undefined,
  now: Date,
) {
  return (
    isWaitingCandidate(row, viewerId, now) &&
    observation?.status === "ready" &&
    observation.settled === true &&
    observation.prompt?.state === "finished" &&
    beforeDeadline(observation.expiresAt, now)
  );
}

/**
 * All is the inventory and Mine is an ownership filter across activity tabs.
 * Working, Waiting for you, Stopped, and Failed are mutually exclusive subsets.
 */
export function sandboxActivityPage(
  rows: SandboxListMetadata[],
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  requestedPage: number,
  turns: ReadonlyMap<string, SandboxTurnObservation>,
  now = new Date(),
) {
  const working = (row: SandboxListMetadata) => row.status === "running" || row.status === "starting";
  const waitingIds = new Set(
    rows.filter((row) => sandboxNeedsViewer(row, viewerId, turns.get(row.id), now)).map((row) => row.id),
  );
  const predicates = {
    all: (_row: SandboxListMetadata) => true,
    mine: (row: SandboxListMetadata) => row.ownerId === viewerId,
    working,
    need: (row: SandboxListMetadata) => waitingIds.has(row.id),
    stopped: (row: SandboxListMetadata) => row.status === "stopped",
    failed: (row: SandboxListMetadata) => row.status === "failed",
  };
  const activity =
    typeof requestedActivity === "string" && Object.hasOwn(predicates, requestedActivity)
      ? (requestedActivity as keyof typeof predicates)
      : "all";
  const counts = Object.fromEntries(
    Object.entries(predicates).map(([key, matches]) => [key, rows.filter(matches).length]),
  ) as Record<keyof typeof predicates, number>;
  const activeRows = rows.filter(predicates[activity]);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(activeRows.length / 50)));
  return { rows: activeRows.slice((page - 1) * 50, page * 50), activity, counts, page, waitingIds };
}
