import { expect, test } from "bun:test";
import { loadStatus, type MainHealth } from "@armada/core";
import { demoConfig, NOW, recordedFetch } from "../../core/test/support.ts";
import { renderStatus } from "../src/render.ts";

test("status renders main health and hides unavailable readings", async () => {
  const { fetch } = recordedFetch();
  const r = await loadStatus(demoConfig(), {
    linearApiKey: "synthetic-key",
    githubToken: "synthetic-token",
    fetch,
    now: () => NOW,
  });
  const health: MainHealth = {
    branch: "trunk",
    head: "b".repeat(40),
    state: "red",
    redSince: { sha: "a".repeat(40), pr: 17, at: NOW.toISOString(), failing: ["test"] },
    fixRunning: null,
    redBeyondWindow: false,
  };
  expect(renderStatus({ ...r, main: health })).toContain("trunk red since #17 (test failing on aaaaaaa)");
  expect(
    renderStatus({ ...r, main: { ...health, state: "running", fixRunning: { sha: "b".repeat(40), pr: 19 } } }),
  ).toContain("trunk red since #17, a fix is running (#19)");
  expect(renderStatus({ ...r, main: { ...health, state: "green", redSince: null } })).toContain("trunk green");
  expect(renderStatus({ ...r, main: null })).not.toContain("trunk");
});
