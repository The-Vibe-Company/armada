import { expect, test } from "bun:test";
import {
  composerChips,
  launchAgentSummary,
  launchHoldIds,
  launchSendLabel,
  launchStopLabel,
  launchToolsSummary,
  prioritizeRepositoryHold,
  templateStartAfterRemoval,
} from "./launch-composer";

test("shows only the settings the starting point accepts", () => {
  expect(composerChips("modal", 1, true)).toEqual({ folder: true, machine: true, access: true, docker: false });
  expect(composerChips("boat", 0, false, true)).toEqual({
    folder: false,
    machine: false,
    access: false,
    docker: false,
  });
  expect(composerChips("docker", 1, true)).toEqual({ folder: false, machine: false, access: false, docker: true });
});

test("only an empty cloud task without a template launches idle", () => {
  expect(launchSendLabel(" \n", false, false)).toBe("Launch idle");
  expect(launchSendLabel("Build the UI", false, false)).toBe("Launch");
  expect(launchSendLabel("", true, false)).toBe("Launch");
  expect(launchSendLabel("", false, true)).toBe("Launch");
});

test("describes every active hold in its display and focus order", () => {
  expect(launchHoldIds("launch", { source: true, account: true, tools: true, template: false })).toEqual([
    "launch-source-blocked",
    "launch-account-unavailable",
    "launch-held",
  ]);
  expect(launchHoldIds("launch", { template: true })).toEqual(["launch-blocked"]);
  expect(launchHoldIds("launch", {})).toEqual([]);
  expect(prioritizeRepositoryHold("missing-snapshot", ["account", "tools"])).toEqual([
    "missing-snapshot",
    "account",
    "tools",
  ]);
});

test("summarizes the agent with the account only when it needs to be identified", () => {
  expect(launchAgentSummary("Codex", "GPT 5", "High")).toBe("Codex · GPT 5 · High");
  expect(launchAgentSummary("Codex", "GPT 5", "High", "Team")).toBe("Codex · GPT 5 · High · Team");
});

test("summarizes default and explicit stop times", () => {
  expect(launchStopLabel("boat", "")).toBe("Stops in 4 hours");
  expect(launchStopLabel("boat", "3600")).toBe("Stops in 1 hour");
});

test("tools summary distinguishes unavailable discovery, one named tool, and empty or multiple selections", () => {
  expect(launchToolsSummary({ unavailable: true, selected: 0 })).toBe("Tools unavailable");
  expect(launchToolsSummary({ unavailable: false, selected: 0 })).toBe("No tools");
  expect(launchToolsSummary({ unavailable: false, selected: 1, selectedName: "Docs" })).toBe("Docs connected");
  expect(launchToolsSummary({ unavailable: false, selected: 2 })).toBe("2 tools");
});

test("removing a template with a vanished snapshot holds its source until another is picked", () => {
  const selected = templateStartAfterRemoval(
    {
      id: "template_one",
      orgId: "org_one",
      name: "Review",
      goldenName: "Removed · Boat cloud",
      definition: {
        provider: "boat",
        goldenId: "removed_one",
        harness: "claude",
        model: "opus",
        reasoningEffort: "high",
        connections: [],
        skills: [],
        variables: [],
      },
      revision: 1,
      repositories: [],
      tools: [],
      blocker: null,
      agent: "Claude Code",
    },
    [
      {
        id: "ready_one",
        provider: "boat",
        golden: "Ready",
        label: "Ready",
        group: "Boat cloud",
        repositories: [],
      },
    ],
  );
  expect(selected.id).toBe("removed_one");
  expect(selected.reason).toContain("no longer available");
});
