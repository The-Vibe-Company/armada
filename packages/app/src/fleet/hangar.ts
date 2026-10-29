// The hangar's numbers (THE-2025): the fleet's facts across the top, and each
// squadron's counts under its name, from the projects the sky draws
// (`skyProject`: sessions in flight and the day's merges). Pure.
import { GROUPS, type Group } from "./overview";
import type { SkyAgent } from "./sky";

export type Counts = Record<Group, number>;

/** How many of these agents are in each state. */
export function countsOf(agents: readonly Pick<SkyAgent, "group">[]): Counts {
  const out = { blocked: 0, you: 0, running: 0, ready: 0, merged: 0 };
  for (const a of agents) out[a.group]++;
  return out;
}

/** Agents in flight: every state but merged. */
export const inFlight = (c: Counts) => c.blocked + c.you + c.running + c.ready;

/** The most urgent state among the agents in flight; null when none flies. */
export function urgentGroup(agents: readonly Pick<SkyAgent, "group">[]): Group | null {
  return GROUPS.find((g) => g !== "merged" && agents.some((a) => a.group === g)) ?? null;
}

/** One count beside its words; `group` colours the number (blocked, waiting for you). */
export interface Fact {
  key: string;
  n: number;
  text: string;
  group: Group | null;
}

/**
 * A squadron's counts under its name: how many are in flight, always; then
 * those moving on their own, blocked, waiting for the owner, ready to merge
 * and merged today, each only when there is one.
 */
export function squadronFacts(c: Counts): Fact[] {
  const facts: Fact[] = [{ key: "flight", n: inFlight(c), text: "in flight", group: null }];
  const more: [Group, string][] = [
    ["running", "on their own"],
    ["blocked", "blocked"],
    ["you", "waiting for you"],
    ["ready", "ready to merge"],
    ["merged", "merged today"],
  ];
  for (const [group, text] of more)
    if (c[group])
      facts.push({ key: group, n: c[group], text, group: group === "blocked" || group === "you" ? group : null });
  return facts;
}

/**
 * The hangar's facts line: agents in flight, moving on their own, ready to
 * merge, merged today, always; then, apart, blocked and waiting for the
 * owner when there are any.
 */
export function hangarFacts(c: Counts): { fleet: Fact[]; owner: Fact[] } {
  const n = inFlight(c);
  return {
    fleet: [
      { key: "flight", n, text: n === 1 ? "agent in flight" : "agents in flight", group: null },
      { key: "running", n: c.running, text: "moving on their own", group: null },
      { key: "ready", n: c.ready, text: "ready to merge", group: "ready" },
      { key: "merged", n: c.merged, text: "merged today", group: null },
    ],
    owner: [
      { key: "blocked", n: c.blocked, text: "blocked", group: "blocked" as const },
      { key: "you", n: c.you, text: "waiting for you", group: "you" as const },
    ].filter((f) => f.n > 0),
  };
}
