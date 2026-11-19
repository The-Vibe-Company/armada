import { expect, test } from "bun:test";
import { checkReaperEvidence, reaperLogLimit } from "./smoke-reaper-evidence.ts";

const now = Date.parse("2026-11-19T10:00:00Z");
const minute = 60_000;

function metric(provider: string, source: string, age = 0, complete = true, overdue = 0) {
  return {
    timestamp: new Date(now - age).toISOString(),
    metric: "reaper_unknown_machines",
    provider,
    source,
    complete,
    overdue,
  };
}

function evidence(...logs: object[]) {
  return checkReaperEvidence(logs.map((log) => JSON.stringify(log)).join("\n"), now);
}

const modal = metric("modal", "app");
const docker = metric("docker", "host");

test("passes on fresh complete zero observations from both staging providers", () => {
  const boat = metric("boat", "account", 0, false, 1);
  expect(evidence(modal, boat, docker).pass).toBe(true);
});

test("reports prior-run physical IDs even after a clean Modal sweep", () => {
  const ids = (provider: string, machineIds: string[]) => ({
    timestamp: new Date(now - 8 * minute).toISOString(),
    event: "reaper_overdue_machines",
    provider,
    machineIds,
  });
  const result = evidence(
    modal,
    docker,
    metric("modal", "app", 8 * minute, true, 1),
    ids("modal", ["sb-orphan", "sb-orphan"]),
    ids("docker", ["armada-orphan"]),
    ids("boat", ["unrelated"]),
  );
  expect(result.pass).toBe(false);
  expect(result.overdueMachineIds).toEqual({ modal: ["sb-orphan"], docker: ["armada-orphan"] });
});

test("fails when an aggregate reports overdue machines without the ID event", () => {
  const result = evidence(modal, docker, metric("docker", "host", minute, true, 1));
  expect(result.pass).toBe(false);
  expect(result.problems).toContain("overdue_machines:docker");
});

test("fails when a newer incomplete observation supersedes a successful one", () => {
  const result = evidence(metric("modal", "app", 0, false), metric("modal", "app", minute), docker);
  expect(result.pass).toBe(false);
  expect(result.problems).toContain("incomplete_reaper_evidence:modal:app");
});

test("requires fresh evidence for both providers and every observed source", () => {
  const result = evidence(modal, metric("modal", "second-app", 6 * minute));
  expect(result.pass).toBe(false);
  expect(result.problems).toEqual(["incomplete_reaper_evidence:modal:second-app", "missing_reaper_evidence:docker"]);
});

test("fails when Modal discovery fails after the last successful observation", () => {
  const result = evidence(metric("modal", "app", minute), docker, {
    timestamp: new Date(now).toISOString(),
    event: "provider_reaper_retry",
    phase: "discovery",
  });
  expect(result.pass).toBe(false);
  expect(result.problems).toContain("modal_discovery_incomplete");
});

test("fails when Railway returns the maximum number of records", () => {
  const result = evidence(modal, ...Array.from({ length: reaperLogLimit - 1 }, () => docker));
  expect(result.pass).toBe(false);
  expect(result.problems).toContain("log_limit_reached");
});
