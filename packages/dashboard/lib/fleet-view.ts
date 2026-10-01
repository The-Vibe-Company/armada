// The view rules the shell and the screens share (THE-866): an agent's status,
// its harness, a project's color, what waits for a decision, the search index
// and where a page sits. Pure: they read the overview the shell polls.
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
  overview: "/",
  projects: "/projects",
  project: (slug: string) => `/projects/${encodeURIComponent(slug)}`,
  agents: (harness?: Harness | null) => (harness ? `/agents?harness=${harness}` : "/agents"),
  agent: (ticket: string) => `/agents/${encodeURIComponent(ticket)}`,
  /** The Agents page scrolled to one of its groups. */
  agentGroup: (status: AgentStatus) => `/agents#${status}`,
  validations: "/validations",
  /** One validation, the link the CLI prints (THE-885). */
  validation: (id: number) => `/approve/${id}`,
  design: "/design",
  /** How fast the fleet ships and where tickets wait (THE-893). */
  insights: "/insights",
} as const;

/** A page of the shell, read from its path. */
export type Place =
  | { kind: "overview" }
  | { kind: "projects" }
  | { kind: "project"; slug: string }
  | { kind: "agents" }
  | { kind: "agent"; ticket: string }
  | { kind: "validations" }
  | { kind: "validation"; id: number }
  | { kind: "organization"; page: "members" | "keys" | "github" | "workers" }
  | { kind: "design" }
  | { kind: "insights" }
  | { kind: "other" };

export function placeOf(pathname: string): Place {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  if (!a) return { kind: "overview" };
  if (a === "projects") return b ? { kind: "project", slug: b } : { kind: "projects" };
  if (a === "agents") return b ? { kind: "agent", ticket: b } : { kind: "agents" };
  if (a === "design") return { kind: "design" };
  if (a === "insights" && !b) return { kind: "insights" };
  if (a === "validations" && !b) return { kind: "validations" };
  if (a === "approve" && b && /^\d+$/.test(b)) return { kind: "validation", id: Number(b) };
  if (a === "organization") {
    if (!b) return { kind: "organization", page: "members" };
    if (b === "keys" || b === "github" || b === "workers") return { kind: "organization", page: b };
  }
  return { kind: "other" };
}

/** The sidebar entry a page belongs to. An agent's page belongs to where it was opened from. */
export type Section = "overview" | "validations" | "projects" | "agents" | "insights" | null;

export function sectionOf(place: Place, from: Place | null): Section {
  if (place.kind === "overview") return "overview";
  if (place.kind === "validations" || place.kind === "validation") return "validations";
  if (place.kind === "projects" || place.kind === "project") return "projects";
  if (place.kind === "agents") return "agents";
  if (place.kind === "insights") return "insights";
  if (place.kind === "agent") {
    if (from?.kind === "overview") return "overview";
    if (from?.kind === "project" || from?.kind === "projects") return "projects";
    return "agents";
  }
  return null;
}

/** One step of the breadcrumbs; the last has no link. */
export type Crumb =
  | {
      kind: "overview" | "projects" | "agents" | "validations" | "insights" | "organization" | "design";
      href: string | null;
    }
  | { kind: "validation"; id: number; href: null }
  | { kind: "project"; slug: string; href: string | null }
  | { kind: "agent"; ticket: string; href: null }
  | { kind: "organization-page"; page: "keys" | "github" | "workers"; href: null };

export function crumbsOf(place: Place, from: Place | null): Crumb[] {
  switch (place.kind) {
    case "overview":
      return [{ kind: "overview", href: null }];
    case "projects":
      return [{ kind: "projects", href: null }];
    case "project":
      return [
        { kind: "projects", href: paths.projects },
        { kind: "project", slug: place.slug, href: null },
      ];
    case "agents":
      return [{ kind: "agents", href: null }];
    case "validations":
      return [{ kind: "validations", href: null }];
    case "validation":
      return [
        { kind: "validations", href: paths.validations },
        { kind: "validation", id: place.id, href: null },
      ];
    case "agent": {
      const last: Crumb = { kind: "agent", ticket: place.ticket, href: null };
      if (from?.kind === "project")
        return [
          { kind: "projects", href: paths.projects },
          { kind: "project", slug: from.slug, href: paths.project(from.slug) },
          last,
        ];
      if (from?.kind === "overview") return [{ kind: "overview", href: paths.overview }, last];
      return [{ kind: "agents", href: paths.agents() }, last];
    }
    case "organization":
      return place.page === "members"
        ? [{ kind: "organization", href: null }]
        : [
            { kind: "organization", href: "/organization" },
            { kind: "organization-page", page: place.page, href: null },
          ];
    case "design":
      return [{ kind: "design", href: null }];
    case "insights":
      return [{ kind: "insights", href: null }];
    default:
      return [];
  }
}

/**
 * Where Esc leads from a page: an agent's page back to the list, project or
 * overview it was opened from (else the agents), a project's page to the
 * projects; a list stays. Always a page of the app, never the browser's history.
 */
export function escapeTarget(place: Place, fromPath: string | null): string | null {
  if (place.kind === "project") return paths.projects;
  if (place.kind === "validation") return paths.validations;
  if (place.kind !== "agent") return null;
  const from = fromPath === null ? null : placeOf(fromPath);
  const back =
    from?.kind === "overview" || from?.kind === "projects" || from?.kind === "project" || from?.kind === "agents";
  return back && fromPath ? fromPath : paths.agents();
}

// ---------------------------------------------------------------------- search

export type SearchKind = "agent" | "project" | "ticket" | "nav";

export interface SearchItem {
  kind: SearchKind;
  /** Unique within the list. */
  key: string;
  label: string;
  /** Ticket id, repository or navigation target, shown on the right. */
  detail: string;
  href: string;
  project: string | null;
  /** For an agent: its status. */
  state: AgentState | null;
  /** Lowercase text matched against the query. */
  hay: string;
}

/** Everything ⌘K reaches: agents in flight, projects, tickets ready to start, then the sections. */
export function searchItems(overview: Pick<FleetOverview, "rows" | "projects" | "ready">): SearchItem[] {
  const names = new Map(overview.projects.map((p) => [p.slug, p.name]));
  const agents: SearchItem[] = overview.rows.map((r) => ({
    kind: "agent",
    key: `agent:${r.project}:${r.id}`,
    label: r.title,
    detail: r.id,
    href: paths.agent(r.id),
    project: r.project,
    state: agentState(r),
    hay: `${r.title} ${r.id} ${names.get(r.project) ?? r.project} ${r.runtime ?? ""}`.toLowerCase(),
  }));
  const projects: SearchItem[] = overview.projects.map((p) => ({
    kind: "project",
    key: `project:${p.slug}`,
    label: p.name,
    detail: p.repository,
    href: paths.project(p.slug),
    project: p.slug,
    state: null,
    hay: `${p.name} ${p.slug} ${p.repository}`.toLowerCase(),
  }));
  const tickets: SearchItem[] = overview.ready.map((r) => ({
    kind: "ticket",
    key: `ticket:${r.project}:${r.id}`,
    label: r.title,
    detail: r.id,
    href: paths.project(r.project),
    project: r.project,
    state: null,
    hay: `${r.title} ${r.id} ${names.get(r.project) ?? r.project}`.toLowerCase(),
  }));
  const nav: SearchItem[] = (["agents", "projects", "overview"] as const).map((to) => ({
    kind: "nav",
    key: `nav:${to}`,
    label: to,
    detail: "",
    href: to === "agents" ? paths.agents() : to === "projects" ? paths.projects : paths.overview,
    project: null,
    state: null,
    hay: to,
  }));
  return [...agents, ...projects, ...tickets, ...nav];
}

/**
 * The items a query keeps, best first: an id or name that starts with the
 * query, then any match. `navWords` gives the navigation items the words they
 * answer to in the viewer's language.
 */
export function filterSearch(
  items: SearchItem[],
  query: string,
  { limit = 9, navWords = {} }: { limit?: number; navWords?: Record<string, string> } = {},
): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const hayOf = (i: SearchItem) => (i.kind === "nav" ? `${i.hay} ${navWords[i.hay] ?? ""}`.toLowerCase() : i.hay);
  const starts = (i: SearchItem) =>
    i.detail.toLowerCase().startsWith(q) || i.label.toLowerCase().startsWith(q) ? 0 : 1;
  return items
    .filter((i) => hayOf(i).includes(q))
    .map((i, k) => ({ i, k, s: starts(i) }))
    .sort((a, b) => a.s - b.s || a.k - b.k)
    .slice(0, limit)
    .map((x) => x.i);
}

// --------------------------------------------------------------------- density

export const DENSITIES = ["compact", "airy"] as const;
export type Density = (typeof DENSITIES)[number];
export const DENSITY_COOKIE = "armada-density";
export const densityOf = (v: string | null | undefined): Density => (v === "airy" ? "airy" : "compact");

/** The component sheet at /design: in development and in the demo only. */
export const designPageEnabled = (env: Record<string, string | undefined>) =>
  env.NODE_ENV !== "production" || !!env.ARMADA_DASHBOARD_DEMO;
