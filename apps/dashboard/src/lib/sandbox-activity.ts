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

export type SandboxActivity = "all" | "mine" | "working" | "need" | "stopped" | "failed" | "deleted";

export type RecordedTurn = "queued" | "running" | "finished";

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

export function isSandboxWorking(
  status: SandboxListMetadata["status"],
  turn: RecordedTurn | undefined,
  expiresAt: string | null = null,
  now: Date = new Date(),
) {
  if (!canHaveActiveTurn(status, expiresAt, now)) return false;
  if (turn === "queued") return true;
  if (turn === "running") return status !== "stopped";
  if (turn === "finished") return false;
  return status === "running";
}

export function sandboxActivityPage(
  rows: SandboxListMetadata[],
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  requestedPage: number,
  turns: Readonly<Record<string, RecordedTurn>>,
  now: Date,
  deleted: { rows: SandboxListMetadata[]; count: number },
) {
  const workingIds = new Set<string>();
  const waitingIds = new Set<string>();
  for (const row of rows) {
    if (!row.canOpen || !canHaveActiveTurn(row.status, row.expiresAt, now)) continue;
    const state = turns[row.id];
    if (isSandboxWorking(row.status, state, row.expiresAt, now)) {
      workingIds.add(row.id);
    } else if (
      state === "finished" &&
      row.ownerId === viewerId &&
      row.status === "ready" &&
      beforeDeadline(row.expiresAt, now)
    ) {
      waitingIds.add(row.id);
    }
  }
  const predicates = {
    all: (_row: SandboxListMetadata) => true,
    mine: (row: SandboxListMetadata) => row.ownerId === viewerId,
    working: (row: SandboxListMetadata) => workingIds.has(row.id),
    need: (row: SandboxListMetadata) => waitingIds.has(row.id),
    stopped: (row: SandboxListMetadata) => row.status === "stopped" && !workingIds.has(row.id),
    failed: (row: SandboxListMetadata) => row.status === "failed",
  } satisfies Record<Exclude<SandboxActivity, "deleted">, (row: SandboxListMetadata) => boolean>;
  const activity: SandboxActivity =
    requestedActivity === "deleted"
      ? "deleted"
      : typeof requestedActivity === "string" && Object.hasOwn(predicates, requestedActivity)
        ? (requestedActivity as keyof typeof predicates)
        : "all";
  const counts = Object.fromEntries(
    Object.entries(predicates).map(([key, matches]) => [key, rows.filter(matches).length]),
  ) as Record<keyof typeof predicates, number>;

  const activeRows = activity === "deleted" ? deleted.rows : rows.filter(predicates[activity]);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(activeRows.length / 50)));
  return {
    rows: activeRows.slice((page - 1) * 50, page * 50),
    activity,
    counts: { ...counts, deleted: deleted.count },
    page,
    workingIds,
    waitingIds,
  };
}
