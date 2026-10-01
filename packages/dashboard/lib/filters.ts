// Filters that live in the address bar (THE-895): every list of the shell
// reads its view from its URL (`?project=widgets&state=error&sort=report`),
// so a link shares it and back/forward restore it. Pure: parse and serialize
// (one canonical order, unknown values dropped), apply and sort each list,
// and the rules a saved view is kept under. The FilterBar
// (components/FilterBar.tsx) writes the URL; the pages read it.
//
// A new list adds one entry to `LISTS`, with the states and sorts it
// understands, a `filter…` function next to the others, and renders
// `<FilterBar list="…" />` in its toolbar. A list that reads its own address
// (THE-894's /activity, a server-rendered GET form) gives its canonical query
// in `OWN_ADDRESS` instead: its views are saved and pinned the same way.
import {
  type AgentPhase,
  type FleetOverview,
  type FleetRow,
  LABEL_PHASES,
  type OwnerValidation,
  type ProjectHealth,
  type ProjectOverview,
} from "@armada/core/read";
import { activityHref, activityQuery } from "./activity-view";
import { AGENT_STATUSES, agentState, decisionsOf, HARNESSES, type Harness, harnessOf } from "./fleet-view";
import { pendingValidations } from "./overview-view";
import { coordinatorHarness, lastActivity } from "./project-view";

export const SORTS = ["age", "report", "phase"] as const;
export type SortKey = (typeof SORTS)[number];

/** What a list may be filtered on; `harness` and `profile` only where they mean something. */
export type FilterField = "project" | "harness" | "state" | "profile" | "mine" | "q" | "sort";

export interface ListFilters {
  project: string | null;
  harness: Harness | null;
  /** An agent's status or phase, a project's health, a validation's outcome. */
  state: string | null;
  profile: string | null;
  /** Only what waits for the viewer. */
  mine: boolean;
  /** Words every result holds; empty for none. */
  q: string;
  /** Null: the list's own order. */
  sort: SortKey | null;
}

export const NO_FILTERS: ListFilters = {
  project: null,
  harness: null,
  state: null,
  profile: null,
  mine: false,
  q: "",
  sort: null,
};

const VALIDATION_STATES = ["pending", "approved", "changes", "answered"] as const;
const HEALTHS = ["blocked", "watch", "on-track"] as const satisfies readonly ProjectHealth[];

interface ListRule {
  path: string;
  fields: readonly FilterField[];
  states: readonly string[];
  sorts: readonly SortKey[];
}

export const LISTS = {
  agents: {
    path: "/agents",
    fields: ["project", "harness", "state", "profile", "mine", "q", "sort"],
    states: [...AGENT_STATUSES, ...LABEL_PHASES],
    sorts: SORTS,
  },
  projects: {
    path: "/projects",
    fields: ["project", "harness", "state", "profile", "mine", "q", "sort"],
    states: HEALTHS,
    sorts: SORTS,
  },
  validations: {
    path: "/validations",
    fields: ["project", "state", "mine", "q", "sort"],
    states: VALIDATION_STATES,
    sorts: ["age", "report"],
  },
  // Its filters are its own (project, ticket, kind, who): see `OWN_ADDRESS`.
  activity: { path: "/activity", fields: [], states: [], sorts: [] },
} as const satisfies Record<string, ListRule>;

export type FilterList = keyof typeof LISTS;
/** The lists the FilterBar draws; the others read their address themselves. */
export type BarList = Exclude<FilterList, "activity">;

/** The canonical query of a list that reads its own address, without a page cursor. */
const OWN_ADDRESS: Partial<Record<FilterList, (query: string) => string>> = {
  activity: (query) =>
    activityHref({ ...activityQuery(Object.fromEntries(new URLSearchParams(query))), before: null }).split("?")[1] ??
    "",
};
export const FILTER_LISTS = Object.keys(LISTS) as FilterList[];
export const isFilterList = (v: unknown): v is FilterList => typeof v === "string" && v in LISTS;

/** The list a page shows, from its path; null for a page without filters. */
export const listOfPath = (pathname: string): FilterList | null =>
  FILTER_LISTS.find((l) => LISTS[l].path === pathname) ?? null;

const TOKEN = /^[\w.-]{1,64}$/;
/** A profile is armada.toml's name for it, spaces and all; no control character. */
const PROFILE = /^[^\p{Cc}]{1,64}$/u;
const MAX_Q = 100;

/** Anything with `get`: URLSearchParams, Next's ReadonlyURLSearchParams. */
export interface Params {
  get(name: string): string | null;
}

/** The list's filters as its URL gives them: what it does not understand is dropped. */
export function parseFilters(list: FilterList, params: Params): ListFilters {
  const rule: ListRule = LISTS[list];
  const has = (f: FilterField) => rule.fields.includes(f);
  const token = (name: string, shape = TOKEN) => {
    const v = params.get(name)?.trim() ?? "";
    return shape.test(v) ? v : null;
  };
  const harness = params.get("harness");
  const state = params.get("state");
  const sort = params.get("sort");
  return {
    project: has("project") ? token("project") : null,
    harness: has("harness") && (HARNESSES as readonly string[]).includes(harness ?? "") ? (harness as Harness) : null,
    state: has("state") && state && rule.states.includes(state) ? state : null,
    profile: has("profile") ? token("profile", PROFILE) : null,
    mine: has("mine") && params.get("mine") === "1",
    q: has("q") ? (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_Q) : "",
    sort: has("sort") && sort && (rule.sorts as readonly string[]).includes(sort) ? (sort as SortKey) : null,
  };
}

/** The filters as a query string, without "?": one order, defaults left out, so equal views have equal URLs. */
export function filterQuery(f: ListFilters): string {
  const out = new URLSearchParams();
  if (f.project) out.set("project", f.project);
  if (f.harness) out.set("harness", f.harness);
  if (f.state) out.set("state", f.state);
  if (f.profile) out.set("profile", f.profile);
  if (f.mine) out.set("mine", "1");
  if (f.q) out.set("q", f.q);
  if (f.sort) out.set("sort", f.sort);
  return out.toString();
}

export function filterHref(list: FilterList, f: ListFilters): string {
  const q = filterQuery(f);
  return q ? `${LISTS[list].path}?${q}` : LISTS[list].path;
}

/** A query string made canonical for the list: parse, then serialize. */
export function canonicalQuery(list: FilterList, query: string): string {
  const q = query.replace(/^\?/, "");
  const own = OWN_ADDRESS[list];
  return own ? own(q) : filterQuery(parseFilters(list, new URLSearchParams(q)));
}

export const hasFilters = (f: ListFilters): boolean => filterQuery(f) !== "";

/** Every word of the query in the text, whatever the case. */
function holds(text: string, q: string): boolean {
  if (!q) return true;
  const hay = text.toLowerCase();
  return q
    .toLowerCase()
    .split(" ")
    .every((w) => hay.includes(w));
}

const byTime = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").localeCompare(b ?? "");

// ------------------------------------------------------------------- agents

export const profileOf = (r: Pick<FleetRow, "profile" | "session">) => r.session?.profile ?? r.profile ?? null;

/** From plan to merge, as the pipeline draws it. */
const PHASE_ORDER: readonly AgentPhase[] = [
  "planning",
  "awaiting-approval",
  "implementing",
  "awaiting-validation",
  "shipping",
  "blocked",
  "ready-to-merge",
  "merged",
  "released",
];

/**
 * The sessions a view keeps, in its order: by age the longest in flight
 * first, by last report the freshest first, by phase from plan to merge.
 */
export function filterAgents(rows: FleetRow[], f: ListFilters, names: Map<string, string> = new Map()): FleetRow[] {
  const kept = rows.filter((r) => {
    const s = agentState(r);
    if (f.project && r.project !== f.project) return false;
    if (f.harness && harnessOf(r.runtime) !== f.harness) return false;
    if (f.state && s.status !== f.state && r.phase !== f.state) return false;
    if (f.profile && profileOf(r) !== f.profile) return false;
    if (f.mine && s.status !== "waiting") return false;
    const text = [r.id, r.title, names.get(r.project) ?? r.project, r.runtime, profileOf(r), r.session?.branch];
    return holds(text.filter(Boolean).join(" "), f.q);
  });
  if (f.sort === "age") return kept.sort((a, b) => byTime(a.since, b.since));
  if (f.sort === "report")
    return kept.sort((a, b) => byTime(b.lastReport ?? b.lastUpdate, a.lastReport ?? a.lastUpdate));
  if (f.sort === "phase")
    return kept.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || byTime(a.since, b.since));
  return kept;
}

// ------------------------------------------------------------------ projects

const HEALTH_ORDER: (ProjectHealth | null)[] = ["blocked", "watch", "on-track", null];

/** What waits for the viewer in a project: a worker's decision or a validation. */
function needsMe(o: Pick<FleetOverview, "waiting"> & Partial<Pick<FleetOverview, "validations">>) {
  const slugs = new Set([...decisionsOf(o).map((w) => w.project), ...pendingValidations(o).map((v) => v.project)]);
  return (slug: string) => slugs.has(slug);
}

/**
 * The projects a view keeps: a harness matches its coordinator or one of its
 * agents, a profile one of its agents. By age the quietest first, by last
 * report the latest first, by phase the most troubled first.
 */
export function filterProjects(
  o: Pick<FleetOverview, "projects" | "rows" | "waiting"> & Partial<Pick<FleetOverview, "validations">>,
  f: ListFilters,
): ProjectOverview[] {
  const mine = needsMe(o);
  const rowsOf = (slug: string) => o.rows.filter((r) => r.project === slug);
  const kept = o.projects.filter((p) => {
    const rows = rowsOf(p.slug);
    if (f.project && p.slug !== f.project) return false;
    if (
      f.harness &&
      coordinatorHarness(p.coordinator.harness ?? null) !== f.harness &&
      !rows.some((r) => harnessOf(r.runtime) === f.harness)
    )
      return false;
    if (f.state && p.health !== f.state) return false;
    if (f.profile && !rows.some((r) => profileOf(r) === f.profile)) return false;
    if (f.mine && !mine(p.slug)) return false;
    return holds([p.name, p.slug, p.repository, p.owner, p.programRoot?.id].filter(Boolean).join(" "), f.q);
  });
  const activity = (p: ProjectOverview) => lastActivity(p, rowsOf(p.slug));
  if (f.sort === "age") return kept.sort((a, b) => byTime(activity(a), activity(b)));
  if (f.sort === "report") return kept.sort((a, b) => byTime(activity(b), activity(a)));
  if (f.sort === "phase") return kept.sort((a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health));
  return kept;
}

// --------------------------------------------------------------- validations

/** The validations a view keeps: by age the oldest first, by last report the latest decided or asked first. */
export function filterValidations(
  list: OwnerValidation[],
  f: ListFilters,
  names: Map<string, string> = new Map(),
): OwnerValidation[] {
  const kept = list.filter((v) => {
    if (f.project && v.project !== f.project) return false;
    if (f.state === "pending" && v.decision) return false;
    if (f.state && f.state !== "pending" && v.decision?.outcome !== f.state) return false;
    if (f.mine && v.decision) return false;
    const text = [v.ticket, v.title, v.what, v.reason, v.author, v.decision?.by, names.get(v.project) ?? v.project];
    return holds(text.filter(Boolean).join(" "), f.q);
  });
  if (f.sort === "age") return kept.sort((a, b) => byTime(a.createdAt, b.createdAt));
  if (f.sort === "report")
    return kept.sort((a, b) => byTime(b.decision?.at ?? b.createdAt, a.decision?.at ?? a.createdAt));
  return kept;
}

// --------------------------------------------------------------- saved views

/** A view the viewer named: a list and its filters, pinned in the sidebar. */
export interface SavedView {
  id: string;
  name: string;
  list: FilterList;
  /** Canonical (`filterQuery`), without "?". */
  query: string;
}

export const VIEW_NAME_MAX = 40;
/** Views one person keeps per organization. */
export const VIEWS_MAX = 20;

export type ViewProblem = "name" | "list" | "full";
/** Why a view was not saved: its own problem, nobody to keep it for (the password gate), or the database. */
export type ViewError = ViewProblem | "no-person" | "failed";

/** A view to save, checked and made canonical; or why it cannot be. */
export function checkView(input: {
  name: unknown;
  list: unknown;
  query: unknown;
}): { ok: true; view: Omit<SavedView, "id"> } | { ok: false; problem: ViewProblem } {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > VIEW_NAME_MAX) return { ok: false, problem: "name" };
  if (!isFilterList(input.list)) return { ok: false, problem: "list" };
  const query = canonicalQuery(input.list, typeof input.query === "string" ? input.query : "");
  return { ok: true, view: { name, list: input.list, query } };
}

export const viewHref = (v: Pick<SavedView, "list" | "query">) =>
  v.query ? `${LISTS[v.list].path}?${v.query}` : LISTS[v.list].path;

/** The view the page shows right now: same list, same filters. */
export const isCurrentView = (v: Pick<SavedView, "list" | "query">, pathname: string, search: string) =>
  LISTS[v.list].path === pathname && canonicalQuery(v.list, search) === v.query;
