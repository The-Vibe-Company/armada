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
