// The overview's rules (THE-1020, design/dashboard-v7): every session in
// flight, and the tickets merged today, in one of five states, most urgent
// first: blocked (it cannot go on without someone), waiting for the owner's
// decision, running on its own, ready to merge, merged today. Each has its
// reason, in words the row shows in its state's color, and its step on the
// six-step bar from plan to merge. "Waiting for your decision" means an
// owner validation still open on the session (THE-885: a merge to approve,
// work to validate, a question the coordinator escalated) or a plan to
// approve. Pure: it reads the overview the shell polls.
import type {
  CiState,
  CoordinatorState,
  FleetOverview,
  FleetRow,
  MergedTicket,
  OwnerValidation,
  ProjectOverview,
} from "@armada/core/read";
import { dayIn } from "./activity-view";
import { pendingValidations } from "./overview-view";

type Validations = Partial<Pick<FleetOverview, "validations">>;

const key = (project: string, ticket: string) => `${project}/${ticket}`;

/** What the owner has to validate on each session, oldest first; a session without one is absent. */
export function ownerChecks(o: Validations): Map<string, OwnerValidation[]> {
  const out = new Map<string, OwnerValidation[]>();
  for (const v of [...pendingValidations(o)].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const k = key(v.project, v.ticket);
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

/** What the owner has to validate on one session, oldest first. */
export const checksOf = (checks: Map<string, OwnerValidation[]>, row: Pick<FleetRow, "project" | "id">) =>
  checks.get(key(row.project, row.id)) ?? [];

/** A session's state on the overview, most urgent first. */
export const SESSION_GROUPS = ["blocked", "you", "running", "ready", "merged"] as const;
export type SessionGroup = (typeof SESSION_GROUPS)[number];

/** Why a session is in its state: the row's colored line, in the viewer's language (lib/i18n.ts). */
export type Reason =
  | { kind: "runtime"; state: "failed" | "gone" }
  /** A worker's question the coordinator has not answered. */
  | { kind: "question"; text: string }
  | { kind: "ci"; pr: number }
  | { kind: "conflict"; pr: number }
  | { kind: "silent"; since: string | null }
  /** Blocked with no open question: the worker's last line. */
  | { kind: "blocked"; text: string | null }
  | { kind: "plan" }
  /** An owner validation: a merge to approve, work to check, a question escalated to the owner. */
  | { kind: "merge"; pr: number | null; ci: CiState | null }
  | { kind: "validation"; text: string }
  | { kind: "owner-question"; text: string }
  /** Awaiting a validation the overview does not hold (yet). */
  | { kind: "awaiting-validation" }
  /** Handed back: the coordinator merges; `by` approved its merge. */
  | { kind: "ready"; pr: number | null; ci: CiState | null; by: string | null }
  | { kind: "merged"; pr: number }
  /** At work: the worker's last line. */
  | { kind: "working"; text: string | null };

/** One line of the overview: a session in flight, or a ticket merged today. */
export interface OverviewItem {
  id: string;
  project: string;
  title: string;
  group: SessionGroup;
  reason: Reason;
  /** On the six steps (Plan, Approval, Code, Review & CI, Ready, Merged): the one at work, 6 once merged. */
  step: number;
  /** The worker's last report, or when it merged. */
  last: string | null;
  /** The session in flight; null for a ticket merged earlier today. */
  row: FleetRow | null;
  /** Its pull request: the row's, or the merged one's. */
  pr: { number: number; url: string } | null;
  /** What the owner has to validate on it, oldest first. */
  checks: OwnerValidation[];
}

/** The six steps of the bar, from plan to merge. */
export const STEPS = 6;

/** Where a session is on the six steps: its phase's, else its flow step (THE-988, THE-987's shipping stage). */
export function sessionStep(row: Pick<FleetRow, "phase" | "step">): number {
  if (row.phase === "merged") return STEPS;
  if (row.phase === "awaiting-approval") return 1;
  if (row.phase === "ready-to-merge") return 4;
  return { plan: 0, implementing: 2, review: 3, ci: 3, merged: STEPS }[row.step];
}

/** The worker's last line: its last report, else its status comment. */
const lastLine = (row: FleetRow): string | null => row.session?.lastReport?.message || row.statusLine?.summary || null;

/** The first line of a text, for a row's one line. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/** A question as core stores it, without its "Options:" list. */
const questionText = (body: string) => firstLine(body.split("\n\nOptions:\n")[0] ?? body);

/** A session's state and why, from its row and what the owner has to validate on it. */
export function sessionState(
  row: FleetRow,
  checks: readonly OwnerValidation[],
  decided: readonly OwnerValidation[] = [],
): { group: SessionGroup; reason: Reason } {
  if (row.phase === "merged") return { group: "merged", reason: { kind: "merged", pr: row.pr?.number ?? 0 } };
  const v = checks[0];
  if (v) {
    const reason: Reason =
      v.kind === "merge"
        ? { kind: "merge", pr: v.pr?.number ?? row.pr?.number ?? null, ci: v.pr?.ci ?? row.pr?.ci ?? null }
        : v.kind === "question"
          ? { kind: "owner-question", text: firstLine(v.what) }
          : { kind: "validation", text: firstLine(v.what) };
    return { group: "you", reason };
  }
  if (row.phase === "awaiting-approval") return { group: "you", reason: { kind: "plan" } };
  if (row.phase === "awaiting-validation") return { group: "you", reason: { kind: "awaiting-validation" } };
  if (row.runtimeState === "failed" || row.runtimeState === "gone")
    return { group: "blocked", reason: { kind: "runtime", state: row.runtimeState } };
  if (row.question) return { group: "blocked", reason: { kind: "question", text: questionText(row.question.body) } };
  if (row.pr && (row.pr.ci === "failure" || row.flags.includes("ci-failing")))
    return { group: "blocked", reason: { kind: "ci", pr: row.pr.number } };
  if (row.pr && (row.pr.mergeable === "CONFLICTING" || row.flags.includes("conflict")))
    return { group: "blocked", reason: { kind: "conflict", pr: row.pr.number } };
  if (row.phase === "blocked") return { group: "blocked", reason: { kind: "blocked", text: lastLine(row) } };
  if (row.silent) return { group: "blocked", reason: { kind: "silent", since: row.lastReport } };
  if (row.phase === "ready-to-merge") {
    const approved = decided.find((d) => d.kind === "merge" && d.decision?.outcome === "approved");
    return {
      group: "ready",
      reason: { kind: "ready", pr: row.pr?.number ?? null, ci: row.pr?.ci ?? null, by: approved?.decision?.by ?? null },
    };
  }
  return { group: "running", reason: { kind: "working", text: lastLine(row) } };
}

/** The tickets a project merged on the viewer's day, newest first. */
export const mergedToday = (p: Pick<ProjectOverview, "merged">, now: number, zone: string): MergedTicket[] => {
  const today = dayIn(new Date(now).toISOString(), zone);
  return (p.merged ?? []).filter((m) => dayIn(m.mergedAt, zone) === today);
};

/**
 * Every line of the overview: the sessions in flight in the overview's order,
 * then each project's tickets merged on the viewer's day (`zone`), newest first.
 */
export function overviewItems(
  o: Pick<FleetOverview, "rows" | "projects"> & Validations,
  { now, zone }: { now: number; zone: string },
): OverviewItem[] {
  const checks = ownerChecks(o);
  const decided = (o.validations ?? []).filter((v) => v.decision);
  const items: OverviewItem[] = o.rows.map((row) => {
    const own = checksOf(checks, row);
    const state = sessionState(
      row,
      own,
      decided.filter((d) => d.project === row.project && d.ticket === row.id),
    );
    return {
      id: row.id,
      project: row.project,
      title: row.title,
      ...state,
      step: sessionStep(row),
      last: row.lastReport,
      row,
      pr: row.pr ? { number: row.pr.number, url: row.pr.url } : null,
      checks: own,
    };
  });
  const shown = new Set(items.map((i) => key(i.project, i.id)));
  for (const p of o.projects)
    for (const m of mergedToday(p, now, zone)) {
      if (shown.has(key(p.slug, m.id))) continue;
      shown.add(key(p.slug, m.id));
      items.push({
        id: m.id,
        project: p.slug,
        title: m.title,
        group: "merged",
        reason: { kind: "merged", pr: m.pr.number },
        step: STEPS,
        last: m.mergedAt,
        row: null,
        pr: m.pr,
        checks: [],
      });
    }
  const isMerged = (i: OverviewItem) => (i.group === "merged" ? 1 : 0);
  const at = (i: OverviewItem) => Date.parse(i.last ?? "") || 0;
  // Array.prototype.sort is stable: the sessions keep the overview's order, then the merges, newest first.
  return items.sort((a, b) => isMerged(a) - isMerged(b) || (isMerged(a) ? at(b) - at(a) : 0));
}

/** How many lines each state holds. */
export function groupCounts(items: readonly Pick<OverviewItem, "group">[]): Record<SessionGroup, number> {
  const out = Object.fromEntries(SESSION_GROUPS.map((g) => [g, 0])) as Record<SessionGroup, number>;
  for (const i of items) out[i.group]++;
  return out;
}

/** The lines of one state, or of one project's, in the order they are shown. */
export interface ItemGroup {
  key: string;
  /** A state, or a project's slug when grouped by project. */
  group: SessionGroup | null;
  project: ProjectOverview | null;
  items: OverviewItem[];
}

const rank = (i: OverviewItem) => SESSION_GROUPS.indexOf(i.group);

/** The list's groups: one per state, or one per project (its lines most urgent first); the empty ones left out. */
export function groupItems(
  items: readonly OverviewItem[],
  by: "state" | "project",
  projects: readonly ProjectOverview[],
): ItemGroup[] {
  const groups: ItemGroup[] =
    by === "state"
      ? SESSION_GROUPS.map((g) => ({ key: g, group: g, project: null, items: items.filter((i) => i.group === g) }))
      : projects.map((p) => ({
          key: p.slug,
          group: null,
          project: p,
          items: items.filter((i) => i.project === p.slug).sort((a, b) => rank(a) - rank(b)),
        }));
  return groups.filter((g) => g.items.length > 0);
}

/** One project's card: its progress, and its sessions blocked, waiting for the owner and running. */
export interface ProjectSummary {
  project: ProjectOverview;
  blocked: number;
  you: number;
  running: number;
  /** Its sessions in flight. */
  live: number;
  coordinator: CoordinatorState;
}

export function projectSummaries(
  projects: readonly ProjectOverview[],
  items: readonly OverviewItem[],
): ProjectSummary[] {
  return projects.map((p) => {
    const own = items.filter((i) => i.project === p.slug);
    const n = groupCounts(own);
    return {
      project: p,
      blocked: n.blocked,
      you: n.you,
      running: n.running,
      live: own.length - n.merged,
      coordinator: p.coordinator.state,
    };
  });
}

/** The overview's headline and the line under it: what is blocked and what waits, then the rest. */
export function overviewHeadline(items: readonly OverviewItem[], projects: number) {
  const n = groupCounts(items);
  return { ...n, live: items.length - n.merged, projects };
}

/**
 * The overview's view, in its address (`/?coordinator=widgets&group=project&view=preview&ticket=WID-15`):
 * the project shown, the grouping, the list alone or with the preview pane,
 * and the session the pane shows. Anything else in it is ignored (older
 * links: `?harness=`, `?state=`, `?sort=`…).
 */
export interface OverviewView {
  project: string | null;
  group: "state" | "project";
  view: "list" | "preview";
  ticket: string | null;
}

const TOKEN = /^[\w.-]{1,64}$/;

export function parseOverviewView(params: { get(name: string): string | null }): OverviewView {
  const token = (name: string) => {
    const v = params.get(name)?.trim() ?? "";
    return TOKEN.test(v) ? v : null;
  };
  return {
    // `?project=` still reads: the links and views from before THE-916.
    project: token("coordinator") ?? token("project"),
    group: params.get("group") === "project" ? "project" : "state",
    view: params.get("view") === "preview" ? "preview" : "list",
    ticket: token("ticket"),
  };
}

/** The view's address: one order, defaults left out, so equal views have equal addresses. */
export function overviewHref(v: OverviewView): string {
  const q = new URLSearchParams();
  if (v.project) q.set("coordinator", v.project);
  if (v.group === "project") q.set("group", "project");
  if (v.view === "preview") q.set("view", "preview");
  if (v.view === "preview" && v.ticket) q.set("ticket", v.ticket);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
