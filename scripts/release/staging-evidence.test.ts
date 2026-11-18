import { expect, test } from "bun:test";
import { authenticStagingEvidence, authenticWakeupEvidence } from "./staging-evidence";

test("only authentic exact-SHA deployment plus smoke evidence permits reuse", () => {
  const sha = "a".repeat(40);
  const run = {
    id: 42,
    run_attempt: 2,
    head_repository: { full_name: "owner/repo" },
    path: ".github/workflows/staging-gated-production.yml",
    event: "workflow_run",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  const job = {
    name: "staging",
    run_id: 42,
    run_attempt: 2,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    steps: ["Migrate then deploy pinned server and dashboard", "Smoke pinned staging"].map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  const accepts = (r = run, jobs = [job]) => authenticStagingEvidence(r, jobs, "owner/repo", sha);
  expect(accepts()).toBe(true);
  expect(accepts({ ...run, event: "push" })).toBe(true);
  for (const patch of [
    { head_repository: { full_name: "fork/repo" } },
    { path: ".github/workflows/release.yml" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "skipped" },
  ])
    expect(accepts({ ...run, ...patch })).toBe(false);
  for (const patch of [
    { run_id: 43 },
    { run_attempt: 1 },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { steps: [] },
    { steps: job.steps.slice(0, 1) },
    { steps: [...job.steps, job.steps[0]] },
    ...["skipped", "failure", "cancelled"].map((conclusion) => ({
      steps: [job.steps[0], { ...job.steps[1], conclusion }],
    })),
  ])
    expect(accepts(run, [{ ...job, ...patch } as typeof job])).toBe(false);
  expect(accepts(run, [])).toBe(false);
  expect(accepts(run, [job, job])).toBe(false);
  expect(authenticStagingEvidence(run, [job], "owner/repo", "a")).toBe(false);
});

test("repeated Release completions coalesce only when the successfully smoked source is still live", () => {
  const sha = "a".repeat(40);
  const run = {
    id: 42,
    run_attempt: 1,
    head_repository: { full_name: "owner/repo" },
    path: ".github/workflows/staging-gated-production.yml",
    event: "workflow_run",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  const steps = ["Migrate then deploy pinned server and dashboard", "Smoke pinned staging"].map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
  const job = {
    name: "staging",
    run_id: 42,
    run_attempt: 1,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    steps,
  };
  const health = { ok: true, version: "2.49.6", commit: sha };
  const accepts = (live: unknown = health, jobs = [job]) =>
    authenticWakeupEvidence(run, jobs, "owner/repo", sha, live, "2.49.6");
  expect(accepts()).toBe(true);
  expect(accepts({ ...health, commit: "b".repeat(40) })).toBe(false);
  expect(accepts(health, [{ ...job, conclusion: "failure" }])).toBe(false);
});
