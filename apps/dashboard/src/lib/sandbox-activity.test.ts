import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "./sandbox-access.ts";
import { type RecordedTurn, sandboxActivityPage } from "./sandbox-activity";
import { sortSandboxes } from "./sandbox-filters";

const noDeleted = { rows: [], count: 0 };
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
  const second = sandboxActivityPage(rows, "viewer", "all", 2, turns, now, noDeleted);
  expect(second.rows.map(({ id }) => id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 50)));
  expect(second.counts).toEqual({ all: 123, mine: 60, need: 60, working: 0, stopped: 0, failed: 0, deleted: 0 });
  expect(sandboxActivityPage(rows, "viewer", undefined, 1, turns, now, noDeleted).activity).toBe("all");
  expect(sandboxActivityPage(rows, "viewer", "mine", 2, turns, now, noDeleted).rows).toHaveLength(10);
  const waiting = sandboxActivityPage(rows, "viewer", "need", 99, turns, now, noDeleted);
  expect(waiting.page).toBe(2);
  expect(waiting.rows.map(({ id }) => id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 50)));
});

test("activity tabs separate active turns from owned, live sandboxes with a finished turn", () => {
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

  const page = sandboxActivityPage(rows, "viewer", "need", 1, turns, now, noDeleted);
  expect(page.rows.map(({ id }) => id)).toEqual(["waiting"]);
  const working = sandboxActivityPage(rows, "viewer", "working", 1, turns, now, noDeleted);
  expect(working.rows.map(({ id }) => id)).toEqual(["stopped-with-queued-turn", "unsettled", "queued", "turn-running"]);
  expect(working.counts).toEqual({ all: 18, mine: 15, need: 1, working: 4, stopped: 2, failed: 1, deleted: 0 });
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
