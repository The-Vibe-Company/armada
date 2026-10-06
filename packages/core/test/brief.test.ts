import { expect, test } from "bun:test";
import { type BriefTicket, buildBrief } from "../src/brief.ts";
import { demoConfig, issue, NOW } from "./support.ts";

test("the Plan line includes the explicit launch reason while needs-approval keeps precedence", () => {
  const ticket: BriefTicket = {
    id: "DEMO-7",
    title: "Parse widgets",
    url: "https://linear.app/acme/issue/DEMO-7",
    branchName: "feature/demo-7",
    description: "A small parser follow-up.",
    status: "Todo",
    statusType: "unstarted",
    labels: ["plan-approved"],
    parent: null,
    notes: [],
    blockers: [],
    warnings: [],
  };
  const input = {
    config: demoConfig(),
    ticket,
    program: {
      rootId: "DEMO-1",
      fetchedAt: NOW.toISOString(),
      issues: [issue("DEMO-1", { parentId: null }), issue("DEMO-7", { parentId: "DEMO-1" })],
      comments: [],
      warnings: [],
    },
    profile: null,
    version: "0.1.0",
    env: {},
    now: NOW,
    preApprovedReason: "small follow-up",
  };
  expect(buildBrief(input).prompt).toContain(
    "Plans are pre-approved for DEMO-7 (the ticket's label plan-approved (added at launch: small follow-up)): post your plan with `armada report implementing --plan-file -` and go on.",
  );
  ticket.labels.push("needs-plan-approval");
  expect(buildBrief(input).plans).toEqual({ rule: "approve", why: "the ticket's label needs-plan-approval" });
});

test("the brief lists live acceptance after Plan with paths, commands and run limits", () => {
  const config = demoConfig();
  config.acceptance = [
    { name: "production build", command: "armada run -- build", paths: ["deploy/**"], timeoutMinutes: 20, maxRuns: 3 },
  ];
  const brief = buildBrief({
    config,
    ticket: {
      id: "DEMO-7",
      title: "build",
      url: "https://linear.app/acme/issue/DEMO-7",
      branchName: "feature/demo-7",
      description: "build",
      status: "Todo",
      statusType: "unstarted",
      labels: [],
      parent: null,
      notes: [],
      blockers: [],
      warnings: [],
    },
    program: {
      rootId: "DEMO-1",
      fetchedAt: NOW.toISOString(),
      issues: [issue("DEMO-1", { parentId: null })],
      comments: [],
      warnings: [],
    },
    profile: null,
    version: "0.1.0",
    env: {},
    now: NOW,
  });
  expect(brief.acceptance).toEqual(config.acceptance);
  expect(brief.prompt.indexOf("## Live acceptance")).toBeGreaterThan(brief.prompt.indexOf("## Plan"));
  for (const text of [
    "production build",
    "armada run -- build",
    "deploy/**",
    "timeout 20 minutes",
    "3 runs per ticket",
    "Bring main in",
    "Every error",
    "armada acceptance run",
    "ask the coordinator",
  ])
    expect(brief.prompt).toContain(text);
});
