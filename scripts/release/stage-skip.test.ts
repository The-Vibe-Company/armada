import { expect, test } from "bun:test";
import { canReuseDashboard, canReuseServer, completedStages, recordedStageSucceeded } from "./stage-skip";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const runUrlPrefix = "https://github.example/owner/repo/actions/runs/";

test("only the requested SHA's successful stage points to a reusable run", () => {
  const statuses = [
    { context: "release/binaries", state: "success", target_url: `${runUrlPrefix}123` },
    { context: "release/check", state: "failure", target_url: `${runUrlPrefix}124` },
  ];
  expect(completedStages(sha, { sha: otherSha, statuses }, runUrlPrefix).size).toBe(0);
  expect(Array.from(completedStages(sha, { sha, statuses }, runUrlPrefix).keys())).toEqual(["binaries"]);
  expect(completedStages(sha, { sha, statuses }, runUrlPrefix).get("binaries")?.run).toBe("123");
});

test("receipt URL must lead to a successful stage for the exact requested SHA", () => {
  const run = { id: 123, head_sha: otherSha };
  const job = {
    name: "Record the complete binary matrix",
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    conclusion: "success",
    steps: [{ name: `Record release/binaries success (${sha})`, conclusion: "success" }],
  };
  expect(recordedStageSucceeded([job], run, "binaries", sha)).toBe(true);
  expect(recordedStageSucceeded([job], run, "binaries", otherSha)).toBe(false);
  expect(recordedStageSucceeded([{ ...job, run_id: 456 }], run, "binaries", sha)).toBe(false);
});

test("a newer attempt that can replace binary artifacts invalidates the old receipt", () => {
  const run = { id: 123, head_sha: sha };
  const recorded = {
    name: "Record the complete binary matrix",
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    conclusion: "success",
    steps: [{ name: `Record release/binaries success (${sha})`, conclusion: "success" }],
  };
  const writer = { ...recorded, name: "Binary (linux-x64)", run_attempt: 2, steps: [] };
  expect(recordedStageSucceeded([recorded, writer], run, "binaries", sha)).toBe(false);
  expect(recordedStageSucceeded([recorded, { ...writer, conclusion: "skipped" }], run, "binaries", sha)).toBe(true);
});

test("server reuse requires a successful deployment of the same pin and exact live health", () => {
  const health = { ok: true, version: "1.2.3", commit: sha };
  const message = "Release with candidate image A";
  const deployment = { status: "SUCCESS", meta: { commitMessage: message } };
  expect(canReuseServer(deployment, message, health, "1.2.3", sha)).toBe(true);
  expect(canReuseServer(deployment, "Release with candidate image B", health, "1.2.3", sha)).toBe(false);
  expect(canReuseServer({ ...deployment, status: "FAILED" }, message, health, "1.2.3", sha)).toBe(false);
  expect(canReuseServer(deployment, message, { ...health, commit: otherSha }, "1.2.3", sha)).toBe(false);
});

test("only the ready production dashboard at the requested SHA is reusable", () => {
  const production = { readyState: "READY", meta: { githubCommitSha: sha } };
  expect(canReuseDashboard({ targets: { production } }, sha)).toBe(true);
  expect(canReuseDashboard({ targets: { production } }, otherSha)).toBe(false);
  expect(canReuseDashboard({ targets: { preview: production } }, sha)).toBe(false);
  expect(canReuseDashboard({ targets: { production: { ...production, readyState: "ERROR" } } }, sha)).toBe(false);
});
