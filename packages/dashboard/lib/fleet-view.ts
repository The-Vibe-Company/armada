// The view rules the shell and the screens share (THE-866): an agent's status,
// its harness, a project's color, what waits for a decision and where a page
// sits (⌘K's index is lib/search.ts). Pure: they read the overview the shell polls.
import type { FleetOverview, FleetRow, WaitingItem, WaitingKind } from "@armada/core/read";

/** An agent's status, as the v4 screens group them: most urgent first. */
export const AGENT_STATUSES = ["waiting", "error", "silent", "running", "done"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Why an agent has its status; each reason has its own label. */
export type StatusReason =
  | "question"
  | "approval"
  | "validation"
  | "ci"
  | "conflict"
  | "blocked"
  | "silent"
  | "ready"
  | "phase";

export interface AgentState {
  status: AgentStatus;
  reason: StatusReason;
}

/** The mockup's rule: a decision first, then a failure, a silence, a hand-back, else the phase at work. */
export function agentState(row: Pick<FleetRow, "phase" | "pr" | "silent" | "question" | "flags">): AgentState {
  if (row.question) return { status: "waiting", reason: "question" };
  if (row.phase === "awaiting-approval") return { status: "waiting", reason: "approval" };
  if (row.phase === "awaiting-validation") return { status: "waiting", reason: "validation" };
  if (row.pr?.ci === "failure" || row.flags.includes("ci-failing")) return { status: "error", reason: "ci" };
  if (row.pr?.mergeable === "CONFLICTING" || row.flags.includes("conflict"))
    return { status: "error", reason: "conflict" };
  if (row.phase === "blocked") return { status: "error", reason: "blocked" };
  if (row.silent) return { status: "silent", reason: "silent" };
  if (row.phase === "ready-to-merge") return { status: "done", reason: "ready" };
  return { status: "running", reason: "phase" };
}

/** The harnesses a session runs on; `other` for a runtime Armada does not know. */
export const HARNESSES = ["conductor", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number] | "other";

/** Product names: the same in every language. */
export const HARNESS_NAME: Record<Harness, string> = {
  conductor: "Conductor Cloud",
  "claude-code": "Claude Code",
  codex: "Codex",
  other: "Other",
};

/** The harness of a runtime label (`Conductor`, `Claude Code`, `Codex`…). */
export function harnessOf(runtime: string | null | undefined): Harness {
  const r = (runtime ?? "").toLowerCase();
  if (r.includes("conductor")) return "conductor";
  if (r.includes("claude")) return "claude-code";
  if (r.includes("codex")) return "codex";
  return "other";
}

export const isHarness = (v: unknown): v is Harness => (HARNESSES as readonly unknown[]).includes(v);

/** The harness a coordinator runs on, from what it recorded (`conductor-cloud`, `terminal`…); null when unknown. */
export function coordinatorHarness(h: string | null | undefined): Harness | null {
  if (!h) return null;
  return h === "conductor-cloud" ? "conductor" : h === "terminal" ? "other" : harnessOf(h);
}

/**
 * Where an agent's session opens, when its harness has a link: Conductor's
 * workspace for a `<workspace>/<session>` handle. Null for a local harness.
 */
export function sessionLink(runtime: string | null | undefined, handle: string | null | undefined): string | null {
  if (harnessOf(runtime) !== "conductor" || !handle) return null;
  const workspace = handle.split("/")[0]?.trim();
  return workspace && /^[\w-]+$/.test(workspace) ? `conductor://workspace?id=${encodeURIComponent(workspace)}` : null;
}

/** One of the six steps from plan to merge: done, the one at work, or to come. */
export type StepState = "done" | "now" | "next";

export const stepStates = (step: number): StepState[] =>
  Array.from({ length: 6 }, (_, k) => (k < step ? "done" : k === step ? "now" : "next"));

/** A pull request's changed files split for display: the folder (grey) and the name, and +/− in five squares. */
export function fileShape(f: { path: string; additions: number; deletions: number }) {
  const cut = f.path.lastIndexOf("/") + 1;
  const total = f.additions + f.deletions;
  const added = total ? Math.round((f.additions / total) * 5) : 0;
  return {
    dir: f.path.slice(0, cut),
    name: f.path.slice(cut),
    bar: Array.from({ length: 5 }, (_, k): "add" | "del" | "none" => (!total ? "none" : k < added ? "add" : "del")),
  };
}

/**
 * The project colors. A slug keeps its color whatever other projects come and
 * go: FNV-1a of the slug picks the entry. The mockup's three land on their
 * colors: Gadgets amber (0), Widgets blue (4), Armada green (6).
 */
export const PROJECT_PALETTE = [
  "#ffb547",
  "#ff8ab8",
  "#5ad8c8",
  "#c49bff",
  "#7ea6ff",
  "#f2d45c",
  "#b6f15a",
  "#d4a373",
  "#a3b1c6",
] as const;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export const projectColor = (slug: string): string =>
  PROJECT_PALETTE[fnv1a(slug) % PROJECT_PALETTE.length] ?? PROJECT_PALETTE[0];

/** What the owner decides: answer a question, approve a plan, let a ready pull request merge. */
export const DECISION_KINDS = ["question", "approval", "hand-back"] as const satisfies readonly WaitingKind[];
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const isDecision = (w: WaitingItem): w is WaitingItem & { kind: DecisionKind } =>
  (DECISION_KINDS as readonly WaitingKind[]).includes(w.kind);

export const decisionsOf = (overview: Pick<FleetOverview, "waiting">) => overview.waiting.filter(isDecision);

/** Sessions per harness, every known harness listed even at zero. */
export function harnessCounts(rows: Pick<FleetRow, "runtime">[]): Record<Harness, number> {
  const counts: Record<Harness, number> = { conductor: 0, "claude-code": 0, codex: 0, other: 0 };
  for (const r of rows) counts[harnessOf(r.runtime)]++;
  return counts;
}

// ------------------------------------------------------------------ addresses

export const paths = {
  /** The sessions in flight, grouped by state (THE-1020). */
  overview: "/",
  /** The overview filtered to one project's sessions. */
  coordinator: (slug: string) => `/?coordinator=${encodeURIComponent(slug)}`,
  projects: "/projects",
  project: (slug: string) => `/projects/${encodeURIComponent(slug)}`,
  agent: (ticket: string) => `/agents/${encodeURIComponent(ticket)}`,
  validations: "/validations",
  /** One validation, the link the CLI prints (THE-885). */
  validation: (id: number) => `/approve/${id}`,
  design: "/design",
  /** How fast the fleet ships and where tickets wait (THE-893). */
  insights: "/insights",
  /** Every event of the fleet, newest first (THE-894). */
  activity: "/activity",
  organization: "/organization",
} as const;

/** A page of the shell, read from its path. */
export type Place =
  | { kind: "overview" }
  | { kind: "projects" }
  | { kind: "project"; slug: string }
  | { kind: "agent"; ticket: string }
  | { kind: "validations" }
  | { kind: "validation"; id: number }
  | { kind: "organization"; page: "members" | "keys" | "github" | "workers" }
  | { kind: "design" }
  | { kind: "insights" }
  | { kind: "activity" }
  | { kind: "other" };

export function placeOf(pathname: string): Place {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  // `/agents` is the overview since THE-916 (its page redirects there).
  if (!a || (a === "agents" && !b)) return { kind: "overview" };
  if (a === "projects") return b ? { kind: "project", slug: b } : { kind: "projects" };
  if (a === "agents" && b) return { kind: "agent", ticket: b };
  if (a === "design") return { kind: "design" };
  if (a === "insights" && !b) return { kind: "insights" };
  if (a === "activity" && !b) return { kind: "activity" };
  if (a === "validations" && !b) return { kind: "validations" };
  if (a === "approve" && b && /^\d+$/.test(b)) return { kind: "validation", id: Number(b) };
  if (a === "organization") {
    if (!b) return { kind: "organization", page: "members" };
    if (b === "keys" || b === "github" || b === "workers") return { kind: "organization", page: b };
  }
  return { kind: "other" };
}

/**
 * The menu's sections (THE-1020, design/dashboard-v7): the overview, the
 * validations, Activity, Insights and the organization. A page out of the
 * menu (an agent, a project) belongs to the overview.
 */
export const SECTIONS = ["overview", "validations", "activity", "insights", "organization"] as const;
export type Section = (typeof SECTIONS)[number] | null;

export function sectionOf(place: Place): Section {
  switch (place.kind) {
    case "overview":
    case "agent":
    case "projects":
    case "project":
      return "overview";
    case "validations":
    case "validation":
      return "validations";
    case "insights":
    case "activity":
    case "organization":
      return place.kind;
    default:
      return null;
  }
}

/** The pages a breadcrumb names. */
export type PageKind = "overview" | "projects" | "validations" | "insights" | "activity";

/** One step of the breadcrumbs; the last has no link. */
export type Crumb =
  | { kind: PageKind | "organization" | "design"; href: string | null }
  | { kind: "validation"; id: number; href: null }
  | { kind: "project"; slug: string; href: string | null }
  | { kind: "agent"; ticket: string; href: null }
  | { kind: "organization-page"; page: "keys" | "github" | "workers"; href: null };

/**
 * The breadcrumbs (design/dashboard-v7): a project and an agent sit under the
 * overview, an agent under its project when it is known (`agentProject`).
 */
export function crumbsOf(place: Place, agentProject: string | null = null): Crumb[] {
  switch (place.kind) {
    case "overview":
      return [{ kind: "overview", href: null }];
    case "projects":
      return [{ kind: "projects", href: null }];
    case "project":
      return [
        { kind: "overview", href: paths.overview },
        { kind: "project", slug: place.slug, href: null },
      ];
    case "validations":
      return [{ kind: "validations", href: null }];
    case "validation":
      return [
        { kind: "validations", href: paths.validations },
        { kind: "validation", id: place.id, href: null },
      ];
    case "agent": {
      const last: Crumb = { kind: "agent", ticket: place.ticket, href: null };
      const home: Crumb = { kind: "overview", href: paths.overview };
      if (!agentProject) return [home, last];
      return [home, { kind: "project", slug: agentProject, href: paths.project(agentProject) }, last];
    }
    case "organization":
      return place.page === "members"
        ? [{ kind: "organization", href: null }]
        : [
            { kind: "organization", href: paths.organization },
            { kind: "organization-page", page: place.page, href: null },
          ];
    case "design":
      return [{ kind: "design", href: null }];
    case "insights":
      return [{ kind: "insights", href: null }];
    case "activity":
      return [{ kind: "activity", href: null }];
    default:
      return [];
  }
}

/**
 * Where Esc leads from a page: an agent's page back to the overview, project
 * or list it was opened from (else the overview), a project's page to the
 * overview; a list stays. Always a page of the app, never the browser's history.
 */
export function escapeTarget(place: Place, fromPath: string | null): string | null {
  if (place.kind === "project") return paths.overview;
  if (place.kind === "validation") return paths.validations;
  if (place.kind !== "agent") return null;
  const from = fromPath === null ? null : placeOf(fromPath);
  const back =
    from?.kind === "overview" || from?.kind === "projects" || from?.kind === "project" || from?.kind === "validations";
  return back && fromPath ? fromPath : paths.overview;
}

/** The component sheet at /design: in development and in the demo only. */
export const designPageEnabled = (env: Record<string, string | undefined>) =>
  env.NODE_ENV !== "production" || !!env.ARMADA_DASHBOARD_DEMO;
