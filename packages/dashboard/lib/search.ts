// ⌘K's index (THE-892: apart from fleet-view.ts, so it loads with the
// palette, not with every page): what the palette reaches, and the items a
// query keeps.
import type { FleetOverview } from "@armada/core/read";
import { type AgentState, agentState, paths } from "./fleet-view";

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
