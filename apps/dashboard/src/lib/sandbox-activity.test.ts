import { expect, test } from "bun:test";
import type { SandboxListMetadata } from "@armada/core";
import { sandboxActivityPage } from "./sandbox-activity";

test("activity counts cover the full filtered inventory while rendering only the requested page", () => {
  const rows = Array.from({ length: 123 }, (_, i) => ({
    id: String(i),
    ownerId: i < 60 ? "viewer" : "other",
    status: "ready",
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
