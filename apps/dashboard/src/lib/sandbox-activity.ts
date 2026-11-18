import type { SandboxListMetadata } from "@armada/core";
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

export function sandboxNeedsViewer(row: SandboxListMetadata, viewerId: string, now: Date) {
  return row.ownerId === viewerId && sandboxListAttention(row, now) !== null;
}

export function sandboxActivityPage(
  rows: SandboxListMetadata[],
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  requestedPage: number,
  now = new Date(),
) {
  const working = (row: SandboxListMetadata) => row.status === "running" || row.status === "starting";
  const need = (row: SandboxListMetadata) => sandboxNeedsViewer(row, viewerId, now);
  const predicates = {
    all: (_row: SandboxListMetadata) => true,
    mine: (row: SandboxListMetadata) => row.ownerId === viewerId,
    working,
    need,
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
  return { rows: activeRows.slice((page - 1) * 50, page * 50), activity, counts, page };
}
