import { idlePauseMessage, type SandboxListMetadata } from "@armada/core";
import { lifecycleView, readLifecycle } from "./lifecycle";

export function sandboxActivityPage(
  rows: SandboxListMetadata[],
  viewerId: string,
  requestedActivity: string | string[] | undefined,
  requestedPage: number,
  now = new Date(),
) {
  const working = (row: SandboxListMetadata) => row.status === "running" || row.status === "starting";
  const need = (row: SandboxListMetadata) =>
    row.ownerId === viewerId &&
    !idlePauseMessage(row, now) &&
    (row.status === "ready" ||
      row.status === "failed" ||
      Boolean(lifecycleView(row.status, readLifecycle(row), now).notice) ||
      (working(row) && Date.parse(row.expiresAt ?? "") - now.getTime() < 30 * 60_000));
  const activity: "all" | "need" | "working" =
    requestedActivity === "all" || requestedActivity === "working" ? requestedActivity : "need";
  const counts = { all: rows.length, need: rows.filter(need).length, working: rows.filter(working).length };
  const activeRows = rows.filter((row) => activity === "all" || (activity === "need" ? need(row) : working(row)));
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(activeRows.length / 50)));
  return { rows: activeRows.slice((page - 1) * 50, page * 50), activity, counts, page };
}
