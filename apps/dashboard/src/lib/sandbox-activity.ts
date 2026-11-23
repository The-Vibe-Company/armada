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

export type SandboxTurnObservation = Pick<
  SandboxStatus,
  "status" | "settled" | "prompt" | "expiresAt" | "statusMessage"
>;

function beforeDeadline(expiresAt: string | null, now: Date) {
  return expiresAt === null || Date.parse(expiresAt) > now.getTime();
}

function canHaveActiveTurn(status: SandboxListMetadata["status"]) {
  return status === "starting" || status === "ready" || status === "running";
}

export function isTurnCandidate(row: SandboxListMetadata) {
  return row.canOpen && canHaveActiveTurn(row.status);
}

function isWaitingCandidate(row: SandboxListMetadata, viewerId: string, now: Date) {
  return row.ownerId === viewerId && row.canOpen && row.status === "ready" && beforeDeadline(row.expiresAt, now);
}

export function sandboxActivityPage(
  rows: SandboxListMetadata[],
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  requestedPage: number,
  turns: ReadonlyMap<string, SandboxTurnObservation>,
  now = new Date(),
) {
  const workingIds = new Set<string>();
  const waitingIds = new Set<string>();
  let turnsIncomplete = false;
  for (const row of rows) {
    if (!isTurnCandidate(row)) continue;
    const turn = turns.get(row.id);
    if (!turn || (turn.status === "ready" && turn.prompt === null && turn.statusMessage)) {
      turnsIncomplete = true;
      continue;
    }
    const state = turn.prompt?.state;
    if (canHaveActiveTurn(turn.status) && (state === "queued" || state === "running")) {
      workingIds.add(row.id);
      continue;
    }
    if (
      isWaitingCandidate(row, viewerId, now) &&
      turn.status === "ready" &&
      turn.settled === true &&
      turn.prompt?.state === "finished" &&
      beforeDeadline(turn.expiresAt, now)
    )
      waitingIds.add(row.id);
  }
  const predicates = {
    all: (_row: SandboxListMetadata) => true,
    mine: (row: SandboxListMetadata) => row.ownerId === viewerId,
    working: (row: SandboxListMetadata) => workingIds.has(row.id),
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
  return {
    rows: activeRows.slice((page - 1) * 50, page * 50),
    activity,
    counts,
    page,
    workingIds,
    waitingIds,
    turnsIncomplete,
  };
}
