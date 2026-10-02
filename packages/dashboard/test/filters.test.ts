import { describe, expect, test } from "bun:test";
import type { FleetOverview, FleetRow, OwnerValidation } from "@armada/core/read";
import {
  canonicalQuery,
  checkView,
  type FILTER_LISTS,
  filterAgents,
  filterHref,
  filterProjects,
  filterQuery,
  filterValidations,
  LISTS,
  type ListFilters,
  listOfPath,
  NO_FILTERS,
  parseFilters,
  viewHref,
} from "../lib/filters.ts";

// Filters in the address (THE-895): synthetic fleet, invented tickets and people.

const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
const row = (id: string, over: Partial<FleetRow> = {}) =>
  ({
    id,
    title: `Ticket ${id}`,
    project: "widgets",
    phase: "implementing",
    pr: null,
    silent: false,
    question: null,
    flags: [],
    runtime: "Conductor",
    profile: "opus",
    session: null,
    since: at(1),
    lastUpdate: at(2),
    lastReport: at(2),
    pipeline: { step: 2, state: "ok" },
    ...over,
  }) as FleetRow;

const rows = [
  row("WID-1", { phase: "planning", since: at(5), lastReport: at(6) }),
  row("WID-2", { phase: "shipping", since: at(1), lastReport: at(9), runtime: "Claude Code", profile: "sonnet" }),
  row("WID-3", { phase: "awaiting-approval", since: at(3), lastReport: at(4) }),
  row("GAD-1", { project: "gadgets", title: "Rotate the keys", since: at(2), lastReport: null, silent: true }),
];
const ids = (list: { id: string }[]) => list.map((r) => r.id);
const f = (over: Partial<ListFilters>): ListFilters => ({ ...NO_FILTERS, ...over });

describe("filters in the address", () => {
  test("round trip: what a view writes reads back the same, in one order, defaults left out", () => {
    const views: [(typeof FILTER_LISTS)[number], ListFilters][] = [
      [
        "agents",
        f({
          project: "widgets",
          harness: "claude-code",
          state: "error",
          profile: "opus",
          mine: true,
          q: "magic link",
          sort: "report",
        }),
      ],
      ["agents", f({ state: "awaiting-approval" })],
      ["projects", f({ state: "watch", sort: "phase", harness: "conductor" })],
      ["validations", f({ state: "approved", q: "email", sort: "age" })],
      ["validations", NO_FILTERS],
    ];
    for (const [list, view] of views) {
      const query = filterQuery(list, view);
      expect(parseFilters(list, new URLSearchParams(query))).toEqual(view);
      expect(filterHref(list, view)).toBe(query ? `${LISTS[list].path}?${query}` : LISTS[list].path);
    }
    expect(filterQuery("projects", f({ sort: "age", q: "a  b ", project: "widgets", mine: true }))).toBe(
      "project=widgets&mine=1&q=a++b+&sort=age",
    );
    // The same view typed in another order is the same address.
    expect(canonicalQuery("projects", "?sort=age&q=x&project=widgets")).toBe("project=widgets&q=x&sort=age");
  });

  test("the overview (THE-916) is the agents list, filtered on a coordinator; its old `project=` still reads", () => {
    expect(listOfPath("/")).toBe("agents");
    expect(filterHref("agents", f({ project: "widgets", state: "error" }))).toBe("/?coordinator=widgets&state=error");
    expect(parseFilters("agents", new URLSearchParams("project=widgets")).project).toBe("widgets");
    expect(parseFilters("agents", new URLSearchParams("coordinator=gadgets&project=widgets")).project).toBe("gadgets");
    expect(canonicalQuery("agents", "sort=age&project=widgets")).toBe("coordinator=widgets&sort=age");
  });

  test("what a list does not understand is dropped: unknown keys and values, another list's states, a phase sort on validations", () => {
    const parsed = parseFilters(
      "validations",
      new URLSearchParams(
        `harness=codex&state=error&sort=phase&profile=opus&project=../etc&mine=yes&q=${"x".repeat(300)}`,
      ),
    );
    expect(parsed).toEqual({ ...NO_FILTERS, q: "x".repeat(100) });
    expect(parseFilters("agents", new URLSearchParams("state=on-track&harness=boat")).state).toBeNull();
    expect(parseFilters("projects", new URLSearchParams("state=on-track")).state).toBe("on-track");
    // A profile is named as armada.toml names it.
    const spaced = f({ profile: "opus 4" });
    expect(parseFilters("agents", new URLSearchParams(filterQuery("agents", spaced)))).toEqual(spaced);
    expect(parseFilters("agents", new URLSearchParams("profile=a%0Ab")).profile).toBeNull();
    expect(listOfPath("/agents/WID-1")).toBeNull();
  });
});

describe("applied to the lists", () => {
  test("agents: project, harness, status or phase, profile, needs me and words", () => {
    expect(ids(filterAgents(rows, f({ project: "widgets" })))).toEqual(["WID-1", "WID-2", "WID-3"]);
    expect(ids(filterAgents(rows, f({ harness: "claude-code" })))).toEqual(["WID-2"]);
    expect(ids(filterAgents(rows, f({ state: "silent" })))).toEqual(["GAD-1"]);
    expect(ids(filterAgents(rows, f({ state: "shipping" })))).toEqual(["WID-2"]);
    expect(ids(filterAgents(rows, f({ profile: "sonnet" })))).toEqual(["WID-2"]);
    expect(ids(filterAgents(rows, f({ mine: true })))).toEqual(["WID-3"]);
    expect(ids(filterAgents(rows, f({ q: "rotate KEYS" })))).toEqual(["GAD-1"]);
    expect(ids(filterAgents(rows, f({ q: "gadget" }), new Map([["gadgets", "Gadget works"]])))).toEqual(["GAD-1"]);
  });

  test("agents sort by age (longest in flight), last report (latest first, none last) and phase (plan to merge)", () => {
    expect(ids(filterAgents(rows, f({ sort: "age" })))).toEqual(["WID-2", "GAD-1", "WID-3", "WID-1"]);
    expect(ids(filterAgents(rows, f({ sort: "report" })))).toEqual(["WID-2", "WID-1", "WID-3", "GAD-1"]);
    expect(ids(filterAgents(rows, f({ sort: "phase" })))).toEqual(["WID-1", "WID-3", "GAD-1", "WID-2"]);
    // Sorting never changes the list it was given.
    expect(ids(rows)).toEqual(["WID-1", "WID-2", "WID-3", "GAD-1"]);
  });

  const project = (slug: string, over: Record<string, unknown> = {}) => ({
    slug,
    name: slug[0]?.toUpperCase() + slug.slice(1),
    repository: `acme/${slug}`,
    owner: null,
    programRoot: null,
    health: "on-track",
    coordinator: { state: "active", seenAt: at(1), harness: "conductor-cloud" },
    ...over,
  });
  const o = {
    projects: [
      project("widgets", { health: "watch" }),
      project("gadgets", { health: "blocked", coordinator: { state: "idle", seenAt: at(8), harness: "terminal" } }),
      project("sprockets"),
    ],
    rows,
    waiting: [{ kind: "approval", project: "widgets", since: at(3) }],
    validations: [{ project: "sprockets", decision: null }],
  } as unknown as Pick<FleetOverview, "projects" | "rows" | "waiting" | "validations">;
  const slugs = (list: { slug: string }[]) => list.map((p) => p.slug);

  test("projects: health, a harness of the coordinator or an agent, a profile, needs me; sorted by activity or health", () => {
    expect(slugs(filterProjects(o, f({ state: "blocked" })))).toEqual(["gadgets"]);
    expect(slugs(filterProjects(o, f({ harness: "claude-code" })))).toEqual(["widgets"]);
    expect(slugs(filterProjects(o, f({ harness: "other" })))).toEqual(["gadgets"]);
    expect(slugs(filterProjects(o, f({ profile: "opus" })))).toEqual(["widgets", "gadgets"]);
    expect(slugs(filterProjects(o, f({ mine: true })))).toEqual(["widgets", "sprockets"]);
    expect(slugs(filterProjects(o, f({ q: "acme/sprock" })))).toEqual(["sprockets"]);
    expect(slugs(filterProjects(o, f({ sort: "phase" })))).toEqual(["gadgets", "widgets", "sprockets"]);
    expect(slugs(filterProjects(o, f({ sort: "report" })))).toEqual(["widgets", "gadgets", "sprockets"]);
    expect(slugs(filterProjects(o, f({ sort: "age" })))).toEqual(["sprockets", "gadgets", "widgets"]);
  });

  test("validations: to decide or by outcome, needs me, words; oldest or latest first", () => {
    const v = (id: number, over: Partial<OwnerValidation>) =>
      ({
        id,
        project: "widgets",
        ticket: `WID-${id}`,
        what: "Check it",
        reason: null,
        title: null,
        author: null,
        createdAt: at(id),
        decision: null,
        ...over,
      }) as OwnerValidation;
    const list = [
      v(1, { decision: { outcome: "approved", answer: null, note: null, by: "Ada", at: at(9) } }),
      v(2, { what: "Check the sign-in email" }),
      v(3, { decision: { outcome: "changes", answer: null, note: null, by: "Ada", at: at(5) } }),
    ];
    const vids = (x: OwnerValidation[]) => x.map((y) => y.id);
    expect(vids(filterValidations(list, f({ state: "pending" })))).toEqual([2]);
    expect(vids(filterValidations(list, f({ mine: true })))).toEqual([2]);
    expect(vids(filterValidations(list, f({ state: "changes" })))).toEqual([3]);
    expect(vids(filterValidations(list, f({ q: "sign-in" })))).toEqual([2]);
    expect(vids(filterValidations(list, f({ q: "ada" })))).toEqual([1, 3]);
    expect(vids(filterValidations(list, f({ sort: "age" })))).toEqual([1, 2, 3]);
    expect(vids(filterValidations(list, f({ sort: "report" })))).toEqual([1, 3, 2]);
  });
});

describe("saved views", () => {
  test("a view is named, checked and kept canonical; it opens its list with its filters", () => {
    expect(checkView({ name: "  Red   CI ", list: "agents", query: "sort=age&state=error&bogus=1" })).toEqual({
      ok: true,
      view: { name: "Red CI", list: "agents", query: "state=error&sort=age" },
    });
    expect(checkView({ name: " ", list: "agents", query: "" })).toEqual({ ok: false, problem: "name" });
    expect(checkView({ name: "x".repeat(41), list: "agents", query: "" })).toEqual({ ok: false, problem: "name" });
    expect(checkView({ name: "Mine", list: "settings", query: "" })).toEqual({ ok: false, problem: "list" });
    const view = { list: "agents" as const, query: "state=error&sort=age" };
    expect(viewHref(view)).toBe("/?state=error&sort=age");
    // A view saved on /agents before THE-916 opens the overview on the same coordinator.
    expect(viewHref({ list: "agents", query: "project=widgets" })).toBe("/?coordinator=widgets");
  });

  test("/activity (THE-894) keeps its own address: a view of it is canonical, without the page cursor", () => {
    expect(checkView({ name: "Merges", list: "activity", query: "who=coordinator&kind=merge&bogus=1" })).toEqual({
      ok: true,
      view: { name: "Merges", list: "activity", query: "kind=merge&who=coordinator" },
    });
    const view = { list: "activity" as const, query: "project=widgets&ticket=WID-2" };
    expect(viewHref(view)).toBe("/activity?project=widgets&ticket=WID-2");
    expect(listOfPath("/activity")).toBe("activity");
  });
});
