// The overview's view rules (THE-867): its headline figures, the decisions
// waiting for the owner, the problems and each project's card. Pure: they read
// the overview the shell polls, and never recompute what core decides (health,
// progress, what waits).
import type { FleetOverview, InboxItem, WaitingItem } from "@armada/core/read";
import { agentState, type DecisionKind, decisionsOf, harnessOf, paths } from "./fleet-view";
import { lastActivity, prCounts, progressPercent } from "./project-view";

/** A question, a plan or a hand-back: what the owner decides. */
export type Decision = WaitingItem & { kind: DecisionKind };

export interface OverviewFigures {
  inFlight: number;
  /** Questions, plans and hand-backs: the sidebar's count. */
  decide: number;
  failing: number;
  silent: number;
  coordinators: { active: number; total: number };
  projects: number;
  /** The harnesses the sessions in flight run on. */
  harnesses: number;
}

export function overviewFigures(o: Pick<FleetOverview, "rows" | "waiting" | "projects">): OverviewFigures {
  const states = o.rows.map((r) => agentState(r).status);
  return {
    inFlight: o.rows.length,
    decide: decisionsOf(o).length,
    failing: states.filter((s) => s === "error").length,
    silent: states.filter((s) => s === "silent").length,
    coordinators: {
      active: o.projects.filter((p) => p.coordinator.state === "active").length,
      total: o.projects.length,
    },
    projects: o.projects.length,
    harnesses: new Set(o.rows.map((r) => harnessOf(r.runtime))).size,
  };
}

/** The decisions the owner makes, oldest first. */
export const decisionCards = (o: Pick<FleetOverview, "waiting">): Decision[] =>
  [...decisionsOf(o)].sort((a, b) => a.since.localeCompare(b.since));

const RECOMMENDED = /\b(recommended\b|recommand)/i;

/** A question's options, the recommended one first; else in the worker's order (the first is its pick). */
export function orderOptions(options: readonly string[]): string[] {
  const pick = options.findIndex((o) => RECOMMENDED.test(o));
  if (pick <= 0) return [...options];
  return [options[pick] as string, ...options.filter((_, k) => k !== pick)];
}

/** At most `max` characters of a text, cut on a word, with an ellipsis. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The pull request a hand-back asks to merge: its row's, else the project's open one for the ticket. */
export function handBackPr(o: Pick<FleetOverview, "rows" | "projects">, w: WaitingItem): number | null {
  if (!w.ticket) return null;
  const row = o.rows.find((r) => r.project === w.project && r.id === w.ticket);
  if (row?.pr) return row.pr.number;
  const project = o.projects.find((p) => p.slug === w.project);
  return project?.pullRequests?.find((pr) => pr.ticket?.id === w.ticket)?.number ?? null;
}

/** A request already waiting for the coordinator on a decision. */
export interface SentRequest {
  body: string;
  author: string | null;
  at: string;
}

/**
 * What the owner already asked about a decision, as the server holds it: the
 * answer to a question or plan, amendments to a plan, the merge of a hand-back.
 */
export function sentRequest(o: Pick<FleetOverview, "projects">, w: WaitingItem, pr: number | null): SentRequest | null {
  if (w.answer) return { body: w.answer.body, author: w.answer.author, at: w.answer.at };
  const requests = o.projects.find((p) => p.slug === w.project)?.requests ?? [];
  const match = (r: InboxItem) =>
    w.kind === "approval"
      ? r.kind === "plan-changes" && w.item !== null && r.request?.question === w.item
      : w.kind === "hand-back" && r.kind === "merge-request" && pr !== null && r.request?.pr === pr;
  const r = requests.find(match);
  return r ? { body: r.body, author: r.author, at: r.createdAt } : null;
}

export const PROBLEM_KINDS = ["ci", "conflict", "blocked", "silent", "not-started"] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export interface Problem {
  kind: ProblemKind;
  project: string;
  ticket: string;
  title: string | null;
  /** Since when: the phase for a failure, the last report for a silence, the launch for one never started. */
  since: string;
  pr: number | null;
  /** The first failing check of a red CI. */
  check: string | null;
  /** The worker's last status, or why a launch shows as not started. */
  detail: string | null;
  href: string;
}

/**
 * What is broken: the agents failing (red CI, conflict with main, blocked) or
 * silent, then the launches no worker claimed. An agent waiting for a decision
 * is a decision, not a problem.
 */
export function problemsOf(o: Pick<FleetOverview, "rows" | "waiting" | "projects">): Problem[] {
  const problems: Problem[] = [];
  for (const r of o.rows) {
    const { status, reason } = agentState(r);
    if (status !== "error" && status !== "silent") continue;
    const kind = reason as ProblemKind;
    const pullRequest = o.projects
      .find((p) => p.slug === r.project)
      ?.pullRequests?.find((pr) => pr.number === r.pr?.number);
    problems.push({
      kind,
      project: r.project,
      ticket: r.id,
      title: r.title,
      since: kind === "silent" ? (r.lastReport ?? r.lastUpdate) : r.since,
      pr: r.pr?.number ?? null,
      check: r.pr?.failingChecks?.[0] ?? pullRequest?.failingChecks[0] ?? null,
      detail: r.statusLine?.summary ?? null,
      href: paths.agent(r.id),
    });
  }
  for (const w of o.waiting)
    if (w.kind === "not-started" && w.ticket)
      problems.push({
        kind: "not-started",
        project: w.project,
        ticket: w.ticket,
        title: w.title,
        since: w.since,
        pr: null,
        check: null,
        detail: w.detail,
        href: paths.project(w.project),
      });
  const rank = (k: ProblemKind) => PROBLEM_KINDS.indexOf(k);
  return problems.sort((a, b) => rank(a.kind) - rank(b.kind) || a.since.localeCompare(b.since));
}

export interface ProjectFacts {
  /** Done tickets out of all under the root, in percent (`progressPercent`); null when unknown. */
  progress: number | null;
  inFlight: number;
  /** Tickets marked ready to start, or whose launch was asked. */
  ready: number;
  /** Null when GitHub was not read. */
  prs: { open: number; green: number } | null;
  /** The latest report of its agents or command of its coordinator. */
  lastActivity: string | null;
}

export function projectFacts(o: Pick<FleetOverview, "rows" | "ready" | "projects">, slug: string): ProjectFacts {
  const p = o.projects.find((x) => x.slug === slug);
  const rows = o.rows.filter((r) => r.project === slug);
  return {
    progress: progressPercent(p?.progress ?? null),
    inFlight: rows.length,
    ready: o.ready.filter((r) => r.project === slug && (r.readyForAgent || r.launch)).length,
    prs: prCounts(p?.pullRequests ?? null),
    lastActivity: p ? lastActivity(p, rows) : null,
  };
}
