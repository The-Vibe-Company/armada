// What the sky (src/sky, THE-2024) draws of a project: its coordinator, each
// session in flight with its state and harness, and the tickets merged on the
// viewer's day. Pure: `now` and the zone are given.
import { dayIn, GROUP_OF, type Group } from "./overview";
import type { FleetState } from "./state";

/** The workers' CLIs (docs/v2-desktop.md): each has its colour in the sky. */
export const HARNESSES = ["claude", "codex", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

export const HARNESS_LABEL: Record<Harness, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

/** The harness a session's runtime names (`claude`, `claude-code`, `codex`, `opencode`); null for any other. */
export function harnessOf(runtime: string | undefined): Harness | null {
  const r = (runtime ?? "").toLowerCase();
  if (r.includes("opencode")) return "opencode";
  if (r.includes("claude")) return "claude";
  if (r.includes("codex")) return "codex";
  return null;
}

export interface SkyAgent {
  /** `project/ticket`: the ship's identity, kept when it changes state or merges. */
  key: string;
  ticket: string;
  group: Group;
  harness: Harness | null;
}

export interface SkyProject {
  id: string;
  name: string;
  /** Whether the project's coordinator flies: one per project (docs/v2-desktop.md). */
  coordinator: boolean;
  /** The sessions in flight in the fold's order, then the tickets merged today, oldest first. */
  agents: SkyAgent[];
}

/**
 * A project's sky from its folded state. Merges come oldest first, so the
 * ticket that merges next takes the merged V's next slot and the others hold
 * theirs. Released sessions and older merges are not in the sky.
 */
export function skyProject(
  project: { id: string; name: string },
  state: FleetState,
  { now, zone }: { now: number; zone: string },
): SkyProject {
  const today = dayIn(now, zone);
  const flying: SkyAgent[] = [];
  const merged: { agent: SkyAgent; at: number }[] = [];
  for (const s of state.sessions) {
    const group = GROUP_OF[s.state];
    if (!group) continue;
    const agent = { key: `${project.id}/${s.ticket}`, ticket: s.ticket, group, harness: harnessOf(s.runtime) };
    if (group !== "merged") flying.push(agent);
    else if (dayIn(s.at, zone) === today) merged.push({ agent, at: Date.parse(s.at) });
  }
  merged.sort((a, b) => a.at - b.at);
  return { id: project.id, name: project.name, coordinator: true, agents: [...flying, ...merged.map((m) => m.agent)] };
}
