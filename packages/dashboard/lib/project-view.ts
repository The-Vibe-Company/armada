// What the Projects list and a project's page show (THE-870), read from the
// overview the shell polls. Pure: health and progress are core's
// (`ProjectOverview.health`, `.progress`), never recomputed here; these only
// pick a project's rows, pull requests and blockers out of the overview.
import type {
  FleetOverview,
  FleetRow,
  ProjectOverview,
  ReadyTicket,
  WaitingItem,
  WaitingPullRequest,
} from "@armada/core/read";
import { type AgentState, agentState, type Harness, harnessOf } from "./fleet-view";

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

/** Open and green pull requests; null when GitHub was not read. */
export function prCounts(pullRequests: ProjectOverview["pullRequests"]): { open: number; green: number } | null {
  if (!pullRequests) return null;
  return { open: pullRequests.length, green: pullRequests.filter((pr) => prState(pr) === "green").length };
}

/** The newest thing that happened on a project: a worker's report or update, or a coordinator command. */
export function lastActivity(
  project: { coordinator: Pick<ProjectOverview["coordinator"], "seenAt"> },
  rows: Pick<FleetRow, "lastReport" | "lastUpdate">[],
): string | null {
  const times = [project.coordinator.seenAt, ...rows.flatMap((r) => [r.lastReport, r.lastUpdate])].filter(
    (at): at is string => !!at,
  );
  return times.reduce<string | null>((newest, at) => (newest === null || at > newest ? at : newest), null);
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

/** Why something blocks a project: an agent's state, a pull request no agent holds, a launch never started, or the coordinator. */
export type BlockerReason = AgentState["reason"] | "not-started" | "coordinator";

export interface Blocker {
  reason: BlockerReason;
  tone: "error" | "waiting" | "silent";
  ticket: string | null;
  /** A pull request no agent in flight holds. */
  pr: number | null;
  /** The question, the worker's last status, the pull request's title. */
  text: string;
  /** The agent's page, or the pull request. */
  href: string | null;
  /** Since when the coordinator leaves its inbox unread. */
  since: string | null;
}

const TONE_RANK = { error: 0, waiting: 1, silent: 2 } as const;

/**
 * What blocks a project, most severe first: failing agents (red CI, conflict,
 * blocked), then decisions waiting for the owner, launches that never started,
 * silent agents, and items the coordinator leaves unread while it is away.
 * An open pull request in red or in conflict that no agent in flight holds
 * blocks too. Each follows the view rules the Agents page uses (`agentState`).
 */
export function projectBlockers(
  project: Pick<ProjectOverview, "slug" | "pullRequests"> & {
    coordinator: Pick<ProjectOverview["coordinator"], "state">;
  },
  rows: FleetRow[],
  waiting: WaitingItem[],
  agentHref: (ticket: string) => string,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const r of rows) {
    const state = agentState(r);
    if (state.status !== "error" && state.status !== "waiting" && state.status !== "silent") continue;
    blockers.push({
      reason: state.reason,
      tone: state.status,
      ticket: r.id,
      pr: null,
      text: r.question?.body.split("\n")[0] ?? r.statusLine?.summary ?? r.title,
      href: agentHref(r.id),
      since: null,
    });
  }
  const held = new Set(rows.flatMap((r) => (r.pr ? [r.pr.number] : [])));
  for (const pr of project.pullRequests ?? []) {
    const state = prState(pr);
    if (held.has(pr.number) || (state !== "red" && state !== "conflict")) continue;
    blockers.push({
      reason: state === "red" ? "ci" : "conflict",
      tone: "error",
      ticket: pr.ticket?.id ?? null,
      pr: pr.number,
      text: pr.title,
      href: pr.url,
      since: null,
    });
  }
  const mine = waiting.filter((w) => w.project === project.slug);
  for (const w of mine)
    if (w.kind === "not-started")
      blockers.push({
        reason: "not-started",
        tone: "silent",
        ticket: w.ticket,
        pr: null,
        text: w.title ?? w.detail ?? "",
        href: null,
        since: w.since,
      });
  const late = mine.map((w) => w.coordinatorSince).filter((at): at is string => !!at);
  if (project.coordinator.state !== "active" && late.length)
    blockers.push({
      reason: "coordinator",
      tone: "waiting",
      ticket: null,
      pr: null,
      text: "",
      href: null,
      since: late.reduce((a, b) => (a < b ? a : b)),
    });
  return blockers
    .map((b, k) => ({ b, k }))
    .sort((x, y) => TONE_RANK[x.b.tone] - TONE_RANK[y.b.tone] || x.k - y.k)
    .map((x) => x.b);
}

/** A project's slice of the overview: its agents in flight, its ready tickets and what waits for the owner. */
export function projectSlice(overview: Pick<FleetOverview, "rows" | "ready" | "waiting">, slug: string) {
  return {
    rows: overview.rows.filter((r) => r.project === slug),
    ready: overview.ready.filter((r) => r.project === slug),
    waiting: overview.waiting.filter((w) => w.project === slug),
  };
}

/** The steps that register a project: all in a terminal, in the repository. */
export const REGISTER_STEPS = [
  { key: "install", command: "npm install -g @the-vibe-company/armada" },
  { key: "login", command: "armada login" },
  { key: "doctor", command: "armada doctor" },
  { key: "init", command: "armada init --program-root <ROOT-ID>" },
] as const;
export type RegisterStep = (typeof REGISTER_STEPS)[number]["key"];
