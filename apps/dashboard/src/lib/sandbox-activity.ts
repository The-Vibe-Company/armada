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

function canHaveActiveTurn(status: SandboxListMetadata["status"], expiresAt: string | null, now: Date) {
  return (
    status === "starting" ||
    status === "ready" ||
    status === "running" ||
    (status === "stopped" && expiresAt !== null && beforeDeadline(expiresAt, now))
  );
}

export function isTurnCandidate(row: SandboxListMetadata, now: Date) {
  return row.canOpen && canHaveActiveTurn(row.status, row.expiresAt, now);
}

function incompleteTurnObservation(turn: SandboxTurnObservation) {
  return (
    (turn.status === "ready" && turn.prompt === null && Boolean(turn.statusMessage)) ||
    turn.statusMessage === "Provider observation unavailable; showing recorded state." ||
    turn.statusMessage === "Stored prompt state is incomplete; live data may be stale."
  );
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
    if (!isTurnCandidate(row, now)) continue;
    const turn = turns.get(row.id);
    if (!turn) {
      turnsIncomplete = true;
      continue;
    }
    const incomplete = incompleteTurnObservation(turn);
    turnsIncomplete ||= incomplete;
    const state = turn.prompt?.state;
    if (
      canHaveActiveTurn(turn.status, turn.expiresAt, now) &&
      (state === "queued" || (!incomplete && state === "running"))
    ) {
      workingIds.add(row.id);
      continue;
    }
    if (
      !incomplete &&
      row.ownerId === viewerId &&
      row.status === "ready" &&
      beforeDeadline(row.expiresAt, now) &&
      turn.status === "ready" &&
      turn.settled === true &&
      state === "finished" &&
      beforeDeadline(turn.expiresAt, now)
    )
      waitingIds.add(row.id);
  }
  const predicates = {
    all: (_row: SandboxListMetadata) => true,
    mine: (row: SandboxListMetadata) => row.ownerId === viewerId,
    working: (row: SandboxListMetadata) => workingIds.has(row.id),
    need: (row: SandboxListMetadata) => waitingIds.has(row.id),
    stopped: (row: SandboxListMetadata) => row.status === "stopped" && !workingIds.has(row.id),
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
