import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import { sandboxActivityPage } from "./sandbox-activity";

test("activity counts cover the full filtered inventory while rendering only the requested page", () => {
  const rows = Array.from({ length: 123 }, (_, i) => ({
    id: String(i),
    ownerId: i < 60 ? "viewer" : "other",
    status: "ready",
    taskOutcome: { state: "ready" },
  })) as SandboxListMetadata[];
  const now = new Date("2026-11-16T00:00:00Z");
  const second = sandboxActivityPage(rows, "viewer", "all", 2, now);
  expect(second.rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 50)));
  expect(second.counts).toEqual({ all: 123, need: 60, working: 0 });
  const attention = sandboxActivityPage(rows, "viewer", undefined, 99, now);
  expect(attention.page).toBe(2);
  expect(attention.rows.map((row) => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 50)));
  expect(sandboxActivityPage(rows, "viewer", "working", 1, now).rows).toEqual([]);
});

test("stopped outcomes, preserved work and urgent deadlines share detail attention across tabs and sort", async () => {
  const { sortSandboxes } = await import("./sandbox-filters");
  const now = new Date("2026-11-16T00:00:00Z");
  const base = { ownerId: "viewer", createdAt: now.toISOString(), status: "stopped" };
  const rows = [
    { ...base, id: "ordinary" },
    { ...base, id: "preserved", preservationNote: "unpushed work preserved at work_recovery:aaaa/bbbb" },
    { ...base, id: "expiring", status: "running", expiresAt: "2026-11-16T00:10:00Z" },
    { ...base, id: "ready", taskOutcome: { state: "ready" } },
    { ...base, id: "blocked", taskOutcome: { state: "blocked", reason: "Need a decision" } },
    { ...base, id: "idle", status: "ready" },
  ] as SandboxListMetadata[];
  const page = sandboxActivityPage(rows, "viewer", "need", 1, now);
  expect(page.rows.map((row) => row.id)).toEqual(["preserved", "expiring", "ready", "blocked"]);
  expect(page.counts).toEqual({ all: 6, need: 4, working: 1 });
  expect(sortSandboxes(rows, "attention", now).map((row) => row.id)).toEqual([
    "blocked",
    "ready",
    "preserved",
    "expiring",
    "idle",
    "ordinary",
  ]);
  expect(sandboxActivityPage(rows, "other", "need", 1, now).rows).toEqual([]);
});
