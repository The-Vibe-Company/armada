// What the Projects list and a project's page show (THE-870), read from the
// overview the shell polls. Pure: health and progress are core's
// (`ProjectOverview.health`, `.progress`), never recomputed here; these only
// pick a project's rows, pull requests and blockers out of the overview.
import type { ProjectOverview, ReadyTicket, WaitingPullRequest } from "@armada/core/read";
import { type Harness, harnessOf } from "./fleet-view";

export const launchProfileLabel = (ticket: Pick<ReadyTicket, "route">, coordinatorChoice: string): string =>
  ticket.route?.profile ?? coordinatorChoice;

/** Done out of total, as a whole percent; null when the project's progress is unknown. */
export function progressPercent(progress: ProjectOverview["progress"]): number | null {
  if (!progress) return null;
  return progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
}

/** An open pull request as a project's page draws it: a conflict wins over its checks. */
export type PrState = "conflict" | "red" | "green" | "pending" | "none";

export function prState(pr: Pick<WaitingPullRequest, "ci" | "mergeable" | "mergeability">): PrState {
  if (pr.mergeable === "CONFLICTING" || pr.mergeability === "conflicting") return "conflict";
  if (pr.ci === "failure") return "red";
  if (pr.ci === "success") return "green";
  if (pr.ci === "pending") return "pending";
  return "none";
}

/**
 * The coordinator's session as a link, when its harness has one: a Conductor
 * Cloud handle is `<workspace>/<session>`, and Conductor opens the workspace.
 * A terminal session has none.
 */
export function coordinatorLink(coordinator: Pick<ProjectOverview["coordinator"], "harness" | "handle">) {
  if (coordinator.harness !== "conductor-cloud" || !coordinator.handle) return null;
  const workspace = coordinator.handle.split("/")[0]?.trim();
  return workspace ? `conductor://workspace?id=${encodeURIComponent(workspace)}` : null;
}

/** The coordinator's harness, on the same scale as the agents'. */
export function coordinatorHarness(harness: ProjectOverview["coordinator"]["harness"]): Harness | null {
  if (!harness) return null;
  if (harness === "conductor-cloud") return "conductor";
  if (harness === "terminal") return "other";
  return harnessOf(harness);
}
