import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { handBackProblems, planRule, transitionProblem } from "../src/phases.ts";
import { LABEL_PHASES, type LabelPhase, type PullRequest } from "../src/types.ts";
import { DEMO_TOML } from "./support.ts";

describe("plan rule", () => {
  test("[policy] plans decides, a ticket label overrides it, and asking for approval wins over pre-approval", () => {
    const approve = parseConfig(DEMO_TOML);
    const preApproved = parseConfig(`${DEMO_TOML}\n[policy]\nplans = "pre-approved"\n`);
    expect(planRule(approve, [])).toEqual({ rule: "approve", why: 'armada.toml [policy] plans = "approve"' });
    expect(planRule(preApproved, ["web"])).toEqual({
      rule: "pre-approved",
      why: 'armada.toml [policy] plans = "pre-approved"',
    });
    expect(planRule(approve, ["Plan Approved"])).toEqual({
      rule: "pre-approved",
      why: "the ticket's label plan-approved",
    });
    expect(planRule(preApproved, ["needs-plan-approval"])).toEqual({
      rule: "approve",
      why: "the ticket's label needs-plan-approval",
    });
    expect(planRule(approve, ["plan-approved", "needs-plan-approval"]).rule).toBe("approve");
  });
});

describe("phase transitions", () => {
  test("the whole table: forward moves, going back where review sends the work, blocked from anywhere", () => {
    const allowed: Record<LabelPhase, LabelPhase[]> = {
      planning: ["planning", "awaiting-approval", "implementing", "blocked"],
      "awaiting-approval": ["awaiting-approval", "planning", "implementing", "blocked"],
      implementing: ["implementing", "shipping", "blocked"],
      shipping: ["shipping", "implementing", "ready-to-merge", "blocked"],
      "ready-to-merge": ["ready-to-merge", "shipping", "blocked"],
      blocked: [...LABEL_PHASES],
    };
    for (const from of LABEL_PHASES)
      for (const to of LABEL_PHASES)
        expect([from, to, transitionProblem(from, to) === null]).toEqual([from, to, allowed[from].includes(to)]);
    expect(transitionProblem("implementing", "ready-to-merge")).toBe(
      "cannot go from implementing to ready-to-merge; from implementing a worker may report: shipping, blocked, implementing (status update)",
    );
    expect(transitionProblem(null, "planning")).toContain("no worker has claimed it");
  });
});

describe("hand-back gate", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    url: "https://github.com/acme/widgets/pull/9",
    number: 9,
    repo: "acme/widgets",
    title: "",
    state: "open",
    headSha: head,
    checks: [
      { name: "test", state: "success" },
      { name: "lint", state: "success" },
    ],
    ...over,
  });
  const gate = (o: { pr?: PullRequest | null; sha?: string | null; required?: string[] }) =>
    handBackProblems({
      pr: o.pr === undefined ? pr() : o.pr,
      repository: "acme/widgets",
      sha: o.sha === undefined ? head : o.sha,
      requiredChecks: o.required ?? [],
    });

  test("an open pull request, its full head SHA and green checks pass", () => {
    expect(gate({})).toEqual([]);
    expect(gate({ required: ["test"], pr: pr({ checks: [{ name: "test", state: "success" }] }) })).toEqual([]);
  });

  test("each malformed hand-back says why", () => {
    expect(gate({ sha: "0123456" })).toEqual([
      '--sha must be the full 40-character commit SHA, got "0123456" (7 characters)',
    ]);
    expect(gate({ sha: null })).toEqual(["--sha is required: the full 40-character head SHA of the pull request"]);
    expect(gate({ sha: "f".repeat(40) })).toEqual([
      `${"f".repeat(40)} is not the head of pull request #9 (head is ${head}); push, then report`,
    ]);
    expect(gate({ pr: null })).toEqual(["no pull request is linked to the ticket; pass --pr <number or URL>"]);
    expect(gate({ pr: pr({ state: "merged" }) })).toEqual(["pull request #9 is merged, not open"]);
    expect(gate({ pr: pr({ draft: true, mergeable: "CONFLICTING" }) })).toEqual([
      "pull request #9 is a draft; mark it ready for review",
      "pull request #9 conflicts with its base; rebase it",
    ]);
    expect(gate({ pr: pr({ repo: "acme/other" }) })).toEqual([
      "pull request #9 is in acme/other, not in the project repository acme/widgets",
    ]);
  });

  test("CI: required checks by name, otherwise every check and at least one", () => {
    const red = pr({
      checks: [
        { name: "test", state: "failure" },
        { name: "lint", state: "pending" },
      ],
    });
    expect(gate({ pr: red })).toEqual(['check "test" is failure', 'check "lint" is pending']);
    expect(gate({ pr: red, required: ["lint", "e2e"] })).toEqual([
      'required check "lint" is pending',
      'required check "e2e" has not reported on the head yet',
    ]);
    const twice = pr({
      checks: [
        { name: "test", state: "success" },
        { name: "test", state: "failure" },
      ],
    });
    expect(gate({ pr: twice, required: ["test"] })).toEqual(['required check "test" is failure']);
    // Only required checks count once they are declared.
    expect(
      gate({ pr: pr({ checks: [...(pr().checks ?? []), { name: "flaky", state: "failure" }] }), required: ["test"] }),
    ).toEqual([]);
    expect(gate({ pr: pr({ checks: [] }) })).toEqual([
      "no CI check has reported on the head yet (or set [gates] required_checks in armada.toml)",
    ]);
  });
});
