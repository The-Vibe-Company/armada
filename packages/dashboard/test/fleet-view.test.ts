import { describe, expect, test } from "bun:test";
import type { FleetRow } from "@armada/core/read";
import {
  agentState,
  attachmentHref,
  coordinatorHarness,
  crumbsOf,
  escapeTarget,
  harnessOf,
  paths,
  placeOf,
  sectionOf,
  sessionLink,
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
    expect(agentState(row({ phase: "awaiting-approval", flags: ["stopped"] }))).toEqual({
      status: "error",
      reason: "stopped",
    });
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

describe("places", () => {
  test("an agent's page sits under the overview and its project, a project's under the overview", () => {
    const agent = placeOf("/agents/WID-15");
    expect(agent).toEqual({ kind: "agent", ticket: "WID-15" });
    expect(crumbsOf(agent, "widgets")).toEqual([
      { kind: "overview", href: "/" },
      { kind: "project", slug: "widgets", href: "/projects/widgets" },
      { kind: "agent", ticket: "WID-15", href: null },
    ]);
    expect(crumbsOf(placeOf("/projects/widgets")).map((c) => c.kind)).toEqual(["overview", "project"]);
    expect(crumbsOf(agent, null)).toEqual([
      { kind: "overview", href: "/" },
      { kind: "agent", ticket: "WID-15", href: null },
    ]);
    expect(placeOf("/organization/keys")).toEqual({ kind: "organization", page: "keys" });
  });

  test("the menu has the overview, Validations, Activity, Insights and the organization; agents and projects are the overview's", () => {
    // THE-916: the Agents page is the overview, and the pages out of the menu belong to it.
    expect(placeOf("/agents")).toEqual({ kind: "overview" });
    for (const path of ["/", "/agents/WID-15", "/projects/widgets"]) expect(sectionOf(placeOf(path))).toBe("overview");
    expect(sectionOf(placeOf("/validations"))).toBe("validations");
    expect(sectionOf(placeOf("/approve/3"))).toBe("validations");
    expect(sectionOf(placeOf("/activity"))).toBe("activity");
    expect(sectionOf(placeOf("/insights"))).toBe("insights");
    expect(sectionOf(placeOf("/organization/keys"))).toBe("organization");
    // The Projects list and the component sheet are gone (THE-1021): their pages redirect to the overview.
    expect(sectionOf(placeOf("/projects"))).toBeNull();
    expect(sectionOf(placeOf("/design"))).toBeNull();
    expect(paths.coordinator("widgets")).toBe("/?coordinator=widgets");
  });

  test("Esc leads to where an agent was opened from, else to the overview, never out of the app", () => {
    const agent = placeOf("/agents/WID-15");
    expect(escapeTarget(agent, "/projects/widgets")).toBe("/projects/widgets");
    expect(escapeTarget(agent, "/")).toBe("/");
    expect(escapeTarget(agent, null)).toBe("/");
    expect(escapeTarget(agent, "/organization/keys")).toBe("/");
    expect(escapeTarget(placeOf("/projects/widgets"), "/agents/WID-15")).toBe("/");
    expect(escapeTarget(placeOf("/"), "/agents/WID-15")).toBeNull();
  });
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
});

test("the link armada attach prints opens the attachment itself (THE-1021)", () => {
  expect(attachmentHref({ tab: "attachments", attachment: "att_01-x" })).toBe("/api/attachments/att_01-x");
  expect(attachmentHref({ tab: "files" })).toBeNull();
  expect(attachmentHref({ attachment: "../../etc" })).toBeNull();
  expect(attachmentHref({ attachment: ["a", "b"] })).toBeNull();
});
