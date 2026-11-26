import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "./sandbox-access.ts";
import { type RecordedTurn, sandboxActivityPage } from "./sandbox-activity";
import { sortSandboxes } from "./sandbox-filters";

const now = new Date("2026-11-16T00:00:00Z");
function row(id: string, overrides: Partial<SandboxListMetadata> = {}) {
  return {
    id,
    orgId: "org",
    ownerId: "viewer",
    provider: "modal",
    providerSandboxId: null,
    harness: "codex",
    model: null,
    reasoningEffort: null,
    status: "ready",
    createdAt: now.toISOString(),
    stoppedAt: null,
    expiresAt: null,
    effectiveTtlSeconds: null,
    machineSize: null,
    displayLabel: id,
    canOpen: true,
    canManage: true,
    ...overrides,
  } satisfies SandboxListMetadata;
}

test("activity counts cover the full filtered inventory while rendering only the requested page", () => {
  const rows = Array.from({ length: 123 }, (_, i) => row(String(i), { ownerId: i < 60 ? "viewer" : "other" }));
  const turns = Object.fromEntries(rows.map(({ id }) => [id, "finished" as const]));
  const second = sandboxActivityPage(rows, "viewer", "all", 2, turns, now);
  expect(second.rows.map(({ id }) => id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 50)));
  expect(second.counts).toEqual({ all: 123, active: 123, need: 60, stopped: 0, failed: 0 });
  expect(sandboxActivityPage(rows, "viewer", undefined, 1, turns, now).activity).toBe("all");
  expect(sandboxActivityPage(rows, "viewer", "mine", 1, turns, now).activity).toBe("all");
  expect(sandboxActivityPage(rows, "viewer", "deleted", 1, turns, now).activity).toBe("all");
  const waiting = sandboxActivityPage(rows, "viewer", "need", 99, turns, now);
  expect(waiting.page).toBe(2);
  expect(waiting.rows.map(({ id }) => id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 50)));
});

test("activity tabs separate active live/working sandboxes from owned live sandboxes waiting for reply", () => {
  const deadline = now.toISOString();
  const rows = [
    row("waiting"),
    row("stopped-with-queued-turn", { status: "stopped", expiresAt: "2026-11-16T00:10:00Z" }),
    row("stopped", { status: "stopped", taskOutcome: { state: "ready" } }),
    row("deleted", { status: "deleted", taskOutcome: { state: "blocked", reason: "Need a decision" } }),
    row("expired", { expiresAt: deadline }),
    row("expired-before-render", { expiresAt: deadline }),
    row("failed", { status: "failed" }),
    row("running", { status: "running", expiresAt: "2026-11-16T00:10:00Z" }),
    row("starting", { status: "starting" }),
    row("stopping", { status: "stopping" }),
    row("stopped-with-stale-running-turn", { status: "stopped", expiresAt: "2026-11-16T00:10:00Z" }),
    row("unsettled"),
    row("queued", { ownerId: "other" }),
    row("restricted", { ownerId: "other", canOpen: false }),
    row("turn-running"),
    row("idle"),
    row("unavailable", { taskOutcome: { state: "ready" } }),
    row("other", { ownerId: "other" }),
  ];
  const turns: Record<string, RecordedTurn> = {
    ...Object.fromEntries(rows.map(({ id }) => [id, "finished" as const])),
    "stopped-with-queued-turn": "queued",
    "stopped-with-stale-running-turn": "running",
    unsettled: "running",
    queued: "queued",
    restricted: "running",
    "turn-running": "running",
  };
  delete turns.idle;
  delete turns.unavailable;

  const page = sandboxActivityPage(rows, "viewer", "need", 1, turns, now);
  expect(page.rows.map(({ id }) => id)).toEqual(["waiting"]);
  const active = sandboxActivityPage(rows, "viewer", "active", 1, turns, now);
  expect([...active.workingIds]).toEqual(["stopped-with-queued-turn", "unsettled", "queued", "turn-running"]);
  expect(active.rows.map(({ id }) => id)).toContain("stopped-with-queued-turn");
  expect(active.rows.map(({ id }) => id)).not.toContain("stopped");
  expect(active.rows.map(({ id }) => id)).not.toContain("failed");
  expect(active.rows.map(({ id }) => id)).not.toContain("deleted");
  expect(active.counts).toEqual({ all: 18, active: 14, need: 1, stopped: 2, failed: 1 });
});

test("workingIds falls back to status running when recorded turns are unavailable", () => {
  const rows = [
    row("running-owned", { status: "running" }),
    row("running-admin-view", { status: "running", ownerId: "other", canOpen: true }),
    row("running-restricted", { status: "running", ownerId: "other", canOpen: false }),
    row("ready-idle", { status: "ready" }),
    row("starting", { status: "starting" }),
    row("stopped", { status: "stopped" }),
  ];
  const page = sandboxActivityPage(rows, "viewer", "active", 1, {}, now);
  expect(page.rows.map(({ id }) => id)).toEqual([
    "running-owned",
    "running-admin-view",
    "running-restricted",
    "ready-idle",
    "starting",
  ]);
  expect([...page.workingIds]).toEqual(["running-owned", "running-admin-view"]);
  expect(page.counts.active).toBe(5);
});

test("attention sort still prioritizes stopped outcomes, preserved work and urgent deadlines", () => {
  const rows = [
    row("ordinary", { status: "stopped" }),
    row("preserved", {
      status: "stopped",
      preservationNote: "unpushed work preserved at work_recovery:aaaa/bbbb",
    }),
    row("expiring", { status: "running", expiresAt: "2026-11-16T00:10:00Z" }),
    row("finished", { status: "stopped", taskOutcome: { state: "ready" } }),
    row("blocked", { status: "stopped", taskOutcome: { state: "blocked", reason: "Need a decision" } }),
    row("idle"),
  ];
  expect(sortSandboxes(rows, "attention", now).map(({ id }) => id)).toEqual([
    "blocked",
    "finished",
    "preserved",
    "expiring",
    "idle",
    "ordinary",
  ]);
});
