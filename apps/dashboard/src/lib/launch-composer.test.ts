import { expect, test } from "bun:test";
import { composerChips, launchAgentSummary, launchHoldIds, launchSendLabel, launchStopLabel } from "./launch-composer";

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
});

test("summarizes the agent with the account only when it needs to be identified", () => {
  expect(launchAgentSummary("Codex", "GPT 5", "High")).toBe("Codex · GPT 5 · High");
  expect(launchAgentSummary("Codex", "GPT 5", "High", "Team")).toBe("Codex · GPT 5 · High · Team");
});

test("summarizes default and explicit stop times", () => {
  expect(launchStopLabel("boat", "")).toBe("Stops in 4 hours");
  expect(launchStopLabel("boat", "3600")).toBe("Stops in 1 hour");
});
