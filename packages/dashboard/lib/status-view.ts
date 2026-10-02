// The pages' status sentences (THE-899): which sentence a page opens with,
// from what it shows. Pure; lib/i18n.ts words them.
import type { FleetRow } from "@armada/core/read";
import { type AgentStatus, agentState } from "./fleet-view";
import type { OverviewFigures } from "./overview-view";

export type OverviewLead = { kind: "away"; merged: number } | { kind: "flight"; agents: number } | { kind: "rest" };
export type OverviewThen =
  | { kind: "decide"; n: number }
  | { kind: "failing"; n: number }
  | { kind: "ready"; n: number }
  | { kind: "calm" };

/**
 * The overview's sentence: "Welcome back. 6 merged while you were away." when
 * the viewer returns, else how many agents fly; then what waits for the owner
 * first, else what fails, else, with nobody in flight, what is ready to start.
 */
export function overviewStatus(
  f: Pick<OverviewFigures, "inFlight" | "decide" | "failing">,
  away: { merged: number } | null,
  ready: number,
): { lead: OverviewLead; then: OverviewThen } {
  const lead: OverviewLead = away
    ? { kind: "away", merged: away.merged }
    : f.inFlight > 0
      ? { kind: "flight", agents: f.inFlight }
      : { kind: "rest" };
  const then: OverviewThen =
    f.decide > 0
      ? { kind: "decide", n: f.decide }
      : f.failing > 0
        ? { kind: "failing", n: f.failing }
        : f.inFlight === 0 && ready > 0
          ? { kind: "ready", n: ready }
          : { kind: "calm" };
  return { lead, then };
}

/** The Agents page's groups that need someone, in the order the page shows them, the empty ones left out. */
export function agentsNeeds(rows: Pick<FleetRow, "phase" | "pr" | "silent" | "question" | "flags">[]) {
  const counts: Partial<Record<AgentStatus, number>> = {};
  for (const r of rows) {
    const s = agentState(r).status;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return (["waiting", "error", "silent"] as const).flatMap((status) =>
    counts[status] ? [{ status, n: counts[status] as number }] : [],
  );
}
