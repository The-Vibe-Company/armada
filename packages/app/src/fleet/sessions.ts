import type { FleetState } from "./state";

/** How many of a project's folded sessions are in flight (neither merged nor released): the sidebar's count. */
export function sessionsInFlight(state: FleetState): number {
  return state.sessions.filter((s) => s.state !== "merged" && s.state !== "released").length;
}
