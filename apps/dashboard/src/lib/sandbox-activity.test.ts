import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "./sandbox-access.ts";
import { type SandboxTurnObservation, sandboxActivityPage } from "./sandbox-activity";
import { sortSandboxes } from "./sandbox-filters";

const now = new Date("2026-11-16T00:00:00Z");
const finished = {
  status: "ready",
  settled: true,
  prompt: { promptId: "turn", conversationId: "conversation", state: "finished", reason: null },
  expiresAt: null,
} satisfies SandboxTurnObservation;

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
  const turns = new Map(rows.map(({ id }) => [id, finished]));
  const second = sandboxActivityPage(rows, "viewer", "all", 2, turns, now);
  expect(second.rows.map(({ id }) => id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 50)));
  expect(second.counts).toEqual({ all: 123, mine: 60, need: 60, working: 0, stopped: 0, failed: 0 });
  expect(sandboxActivityPage(rows, "viewer", undefined, 1, turns, now).activity).toBe("all");
  expect(sandboxActivityPage(rows, "viewer", "mine", 2, turns, now).rows).toHaveLength(10);
  const waiting = sandboxActivityPage(rows, "viewer", "need", 99, turns, now);
  expect(waiting.page).toBe(2);
  expect(waiting.turnsIncomplete).toBe(false);
  expect(waiting.rows.map(({ id }) => id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 50)));
});

test("activity tabs separate active turns from owned, live sandboxes with a finished turn", () => {
  const deadline = now.toISOString();
  const rows = [
    row("waiting"),
    row("stopped", { status: "stopped", taskOutcome: { state: "ready" } }),
    row("deleted", { status: "deleted", taskOutcome: { state: "blocked", reason: "Need a decision" } }),
    row("expired", { expiresAt: deadline }),
    row("expired-since-list-read"),
    row("failed", { status: "failed" }),
    row("running", { status: "running", expiresAt: "2026-11-16T00:10:00Z" }),
    row("starting", { status: "starting" }),
    row("stopping", { status: "stopping" }),
    row("stopped-since-list-read"),
    row("unsettled"),
    row("queued", { ownerId: "other" }),
    row("restricted", { ownerId: "other", canOpen: false }),
    row("turn-running"),
    row("idle"),
    row("unavailable", { taskOutcome: { state: "ready" } }),
    row("other", { ownerId: "other" }),
  ];
  const turns = new Map<string, SandboxTurnObservation>(rows.map(({ id }) => [id, finished]));
  turns.set("expired-since-list-read", { ...finished, expiresAt: deadline });
  turns.set("stopped-since-list-read", { ...finished, status: "stopped" });
  turns.set("unsettled", { ...finished, settled: false });
  turns.set("queued", { ...finished, prompt: { ...finished.prompt, state: "queued" } });
  turns.set("restricted", { ...finished, prompt: { ...finished.prompt, state: "running" } });
  turns.set("turn-running", { ...finished, prompt: { ...finished.prompt, state: "running" } });
  turns.set("idle", { ...finished, prompt: null });
  turns.delete("unavailable");

  const page = sandboxActivityPage(rows, "viewer", "need", 1, turns, now);
  expect(page.rows.map(({ id }) => id)).toEqual(["waiting"]);
  expect(page.counts).toEqual({ all: 17, mine: 14, need: 1, working: 2, stopped: 1, failed: 1 });

  const working = sandboxActivityPage(rows, "viewer", "working", 1, turns, now);
  expect(working.rows.map(({ id }) => id)).toEqual(["queued", "turn-running"]);
});

test("Waiting for you reports incomplete evidence for a recorded fallback, but not for an idle machine", () => {
  const rows = [row("idle")];
  const idle = { ...finished, prompt: null };
  const recorded = { ...idle, statusMessage: "Provider observation unavailable; showing recorded state." };
  expect(sandboxActivityPage(rows, "viewer", "need", 1, new Map([["idle", idle]]), now).turnsIncomplete).toBe(false);
  expect(sandboxActivityPage(rows, "viewer", "need", 1, new Map([["idle", recorded]]), now).turnsIncomplete).toBe(true);
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
