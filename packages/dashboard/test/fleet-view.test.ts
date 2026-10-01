import { describe, expect, test } from "bun:test";
import type { FleetRow } from "@armada/core/read";
import {
  agentState,
  coordinatorHarness,
  crumbsOf,
  densityOf,
  designPageEnabled,
  escapeTarget,
  fileShape,
  harnessOf,
  PROJECT_PALETTE,
  placeOf,
  projectColor,
  sectionOf,
  sessionLink,
  stepStates,
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

test("density defaults to compact, and the component sheet shows in development and demo only", () => {
  expect([densityOf("airy"), densityOf(undefined), densityOf("bogus")]).toEqual(["airy", "compact", "compact"]);
  expect(designPageEnabled({ NODE_ENV: "development" })).toBe(true);
  expect(designPageEnabled({ NODE_ENV: "production" })).toBe(false);
  expect(designPageEnabled({ NODE_ENV: "production", ARMADA_DASHBOARD_DEMO: "fleet" })).toBe(true);
});

describe("an agent's page", () => {
  test("a coordinator's harness, from what it recorded", () => {
    expect(coordinatorHarness("conductor-cloud")).toBe("conductor");
    expect(coordinatorHarness("claude-code")).toBe("claude-code");
    expect(coordinatorHarness("codex")).toBe("codex");
    expect(coordinatorHarness("terminal")).toBe("other");
    expect(coordinatorHarness(null)).toBeNull();
  });

  test("only a Conductor session opens in Conductor, by its workspace", () => {
    expect(sessionLink("Conductor", "ws-4f2a/ses-91")).toBe("conductor://workspace?id=ws-4f2a");
    expect(sessionLink("Claude Code", "ws-4f2a/ses-91")).toBeNull();
    expect(sessionLink("Conductor", null)).toBeNull();
    expect(sessionLink("Conductor", "local tty/s004")).toBeNull();
  });

  test("steps before the current one are done, after it to come", () => {
    expect(stepStates(2)).toEqual(["done", "done", "now", "next", "next", "next"]);
    expect(stepStates(5)).toEqual(["done", "done", "done", "done", "done", "now"]);
  });

  test("a changed file splits into folder and name, its +/- into five squares", () => {
    expect(fileShape({ path: "src/auth/routes.ts", additions: 38, deletions: 6 })).toEqual({
      dir: "src/auth/",
      name: "routes.ts",
      bar: ["add", "add", "add", "add", "del"],
    });
    expect(fileShape({ path: "README.md", additions: 0, deletions: 0 }).bar).toEqual(Array(5).fill("none"));
  });
});
