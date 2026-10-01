import { describe, expect, test } from "bun:test";
import type { FleetRow } from "@armada/core/read";
import {
  agentState,
  crumbsOf,
  densityOf,
  designPageEnabled,
  escapeTarget,
  filterSearch,
  harnessOf,
  PROJECT_PALETTE,
  placeOf,
  projectColor,
  type SearchItem,
  searchItems,
  sectionOf,
} from "../lib/fleet-view.ts";

type Bits = Pick<FleetRow, "phase" | "pr" | "silent" | "question" | "flags">;
const row = (over: Partial<Bits> = {}): Bits => ({
  phase: "implementing",
  pr: null,
  silent: false,
  question: null,
  flags: [],
  ...over,
});
const pr = (ci: "success" | "failure" | "pending", mergeable = "MERGEABLE") => ({
  number: 1,
  url: "https://github.com/acme/widgets/pull/1",
  title: "x",
  draft: false,
  ci,
  mergeable,
});
const question = { id: 1, body: "?", at: "2026-10-01T10:00:00Z", author: null, answer: null };

describe("agentState", () => {
  test("a decision comes first, then a failure, a silence, a hand-back, else the phase", () => {
    expect(agentState(row({ phase: "blocked", question, silent: true }))).toEqual({
      status: "waiting",
      reason: "question",
    });
    expect(agentState(row({ phase: "awaiting-approval", silent: true })).reason).toBe("approval");
    expect(agentState(row({ phase: "shipping", pr: pr("failure"), silent: true })).reason).toBe("ci");
    expect(agentState(row({ phase: "shipping", pr: pr("pending", "CONFLICTING") })).reason).toBe("conflict");
    expect(agentState(row({ phase: "blocked" }))).toEqual({ status: "error", reason: "blocked" });
    expect(agentState(row({ silent: true })).status).toBe("silent");
    expect(agentState(row({ phase: "ready-to-merge", pr: pr("success") })).status).toBe("done");
    expect(agentState(row({ phase: "planning" }))).toEqual({ status: "running", reason: "phase" });
  });
});

test("harnessOf reads every runtime label Armada writes", () => {
  expect(["Conductor", "Conductor Cloud", "Claude Code", "claude-code", "Codex", "boat", null].map(harnessOf)).toEqual([
    "conductor",
    "conductor",
    "claude-code",
    "claude-code",
    "codex",
    "other",
    "other",
  ]);
});

test("a project keeps its color whatever other projects exist", () => {
  const color = projectColor("quivr-v2");
  expect(PROJECT_PALETTE).toContain(color as (typeof PROJECT_PALETTE)[number]);
  expect(projectColor("quivr-v2")).toBe(color);
});

describe("places", () => {
  test("an agent's page belongs to where it was opened from", () => {
    const agent = placeOf("/agents/WID-15");
    expect(agent).toEqual({ kind: "agent", ticket: "WID-15" });
    const project = placeOf("/projects/widgets");
    expect(sectionOf(agent, project)).toBe("projects");
    expect(sectionOf(agent, placeOf("/"))).toBe("overview");
    expect(sectionOf(agent, null)).toBe("agents");
    expect(crumbsOf(agent, project).map((c) => c.kind)).toEqual(["projects", "project", "agent"]);
    expect(crumbsOf(agent, null)).toEqual([
      { kind: "agents", href: "/agents" },
      { kind: "agent", ticket: "WID-15", href: null },
    ]);
    expect(placeOf("/organization/keys")).toEqual({ kind: "organization", page: "keys" });
  });

  test("Esc leads to where an agent was opened from, else to the parent, never out of the app", () => {
    const agent = placeOf("/agents/WID-15");
    expect(escapeTarget(agent, "/projects/widgets")).toBe("/projects/widgets");
    expect(escapeTarget(agent, "/")).toBe("/");
    expect(escapeTarget(agent, null)).toBe("/agents");
    expect(escapeTarget(agent, "/organization/keys")).toBe("/agents");
    expect(escapeTarget(placeOf("/projects/widgets"), "/agents/WID-15")).toBe("/projects");
    expect(escapeTarget(placeOf("/agents"), "/")).toBeNull();
  });
});

describe("search", () => {
  const items = searchItems({
    projects: [
      {
        slug: "widgets",
        name: "Widgets",
        repository: "acme/widgets",
      } as never,
    ],
    rows: [
      { id: "WID-15", project: "widgets", title: "Sign in with a magic link", runtime: "Conductor", ...row() },
    ] as never,
    ready: [{ id: "WID-20", project: "widgets", title: "Let users change their email address" }] as never,
  });
  const keys = (list: SearchItem[]) => list.map((i) => i.key);

  test("reaches agents, projects, ready tickets and the sections, each with its address", () => {
    expect(items.map((i) => `${i.kind} ${i.href}`)).toEqual([
      "agent /agents/WID-15",
      "project /projects/widgets",
      "ticket /projects/widgets",
      "nav /agents",
      "nav /projects",
      "nav /",
    ]);
  });

  test("keeps what matches, an id or name starting with the query first", () => {
    expect(keys(filterSearch(items, "wid"))).toEqual([
      "agent:widgets:WID-15",
      "project:widgets",
      "ticket:widgets:WID-20",
    ]);
    expect(keys(filterSearch(items, "email"))).toEqual(["ticket:widgets:WID-20"]);
    expect(keys(filterSearch(items, "projets", { navWords: { projects: "Projets" } }))).toEqual(["nav:projects"]);
    expect(filterSearch(items, "", { limit: 2 })).toHaveLength(2);
  });
});

test("density defaults to compact, and the component sheet shows in development and demo only", () => {
  expect([densityOf("airy"), densityOf(undefined), densityOf("bogus")]).toEqual(["airy", "compact", "compact"]);
  expect(designPageEnabled({ NODE_ENV: "development" })).toBe(true);
  expect(designPageEnabled({ NODE_ENV: "production" })).toBe(false);
  expect(designPageEnabled({ NODE_ENV: "production", ARMADA_DASHBOARD_DEMO: "fleet" })).toBe(true);
});
