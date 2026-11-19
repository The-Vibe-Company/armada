import { expect, test } from "bun:test";
import { canReuseDashboard, canReuseServer, completedStages } from "./stage-skip";

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

test("server reuse requires both successful deployment and exact live health", () => {
  const health = { ok: true, version: "1.2.3", commit: sha };
  expect(canReuseServer("SUCCESS", health, "1.2.3", sha)).toBe(true);
  expect(canReuseServer("FAILED", health, "1.2.3", sha)).toBe(false);
  expect(canReuseServer("SUCCESS", { ...health, commit: otherSha }, "1.2.3", sha)).toBe(false);
});

test("only the ready production dashboard at the requested SHA is reusable", () => {
  const production = { readyState: "READY", meta: { githubCommitSha: sha } };
  expect(canReuseDashboard({ targets: { production } }, sha)).toBe(true);
  expect(canReuseDashboard({ targets: { production } }, otherSha)).toBe(false);
  expect(canReuseDashboard({ targets: { preview: production } }, sha)).toBe(false);
  expect(canReuseDashboard({ targets: { production: { ...production, readyState: "ERROR" } } }, sha)).toBe(false);
});
