// The horizon (THE-899, design/dashboard-v5): the glow along the deck's top
// edge takes the state of what the page shows, beside its status sentence.
// Orange when something waits for the owner, red when a session fails and
// nothing waits for the owner (or a reading failed), lime when everything in
// flight is ready to merge, blue otherwise. An agent's page takes its agent's
// state, a project's page its project's; Insights, the design sheet and the
// organization's pages stay calm. Pure: it reads the overview the shell polls.
import type { FleetOverview } from "@armada/core/read";
import { type AgentStatus, agentState, type Place } from "./fleet-view";
import { overviewFigures } from "./overview-view";

export type Horizon = "calm" | "yours" | "fail" | "clear";

type Fleet = Pick<FleetOverview, "rows" | "waiting" | "projects"> & Partial<Pick<FleetOverview, "validations">>;

const AGENT: Record<AgentStatus, Horizon> = {
  waiting: "yours",
  silent: "yours",
  error: "fail",
  running: "calm",
  done: "clear",
};

/** A fleet's horizon: what waits for the owner first, then what fails, then whether all of it shipped. */
function fleetHorizon(o: Fleet): Horizon {
  const f = overviewFigures(o);
  if (f.decide > 0) return "yours";
  if (f.failing > 0) return "fail";
  if (o.rows.length > 0 && o.rows.every((r) => agentState(r).status === "done")) return "clear";
  return "calm";
}

/** One project's part of the fleet. */
const scoped = (o: Fleet, slug: string): Fleet => ({
  rows: o.rows.filter((r) => r.project === slug),
  waiting: o.waiting.filter((w) => w.project === slug),
  projects: o.projects.filter((p) => p.slug === slug),
  validations: o.validations?.filter((v) => v.project === slug),
});

export function horizonOf(o: Fleet, place: Place, failed = false): Horizon {
  if (failed) return "fail";
  switch (place.kind) {
    case "agent": {
      const row = o.rows.find((r) => r.id === place.ticket);
      return row ? AGENT[agentState(row).status] : "calm";
    }
    case "project":
      return fleetHorizon(scoped(o, place.slug));
    case "overview":
    case "agents":
    case "projects":
    case "validations":
    case "validation":
    case "activity":
      return fleetHorizon(o);
    default:
      return "calm";
  }
}
