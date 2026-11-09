import { describe, expect, test } from "bun:test";
import { formatDuration, lifecycleView, readLifecycle, type SandboxLifecycle } from "../src/lib/lifecycle.ts";

const NOW = new Date("2026-11-09T12:00:00Z");
const BASE: SandboxLifecycle = {
  expiresAt: "2026-11-09T13:20:00Z",
  effectiveTtlSeconds: 8 * 3600,
  requestedTtlSeconds: null,
  lastObservedAt: "2026-11-09T11:59:00Z",
  lifecycleError: null,
};

describe("sandbox lifecycle", () => {
  test("a legacy row without the #565 fields says nothing about its lifetime", () => {
    const lifecycle = readLifecycle({ id: "x", status: "running" });
    expect(lifecycle).toEqual({
      expiresAt: null,
      effectiveTtlSeconds: null,
      requestedTtlSeconds: null,
      lastObservedAt: null,
      lifecycleError: null,
    });
    expect(lifecycleView("running", lifecycle, NOW)).toEqual({ lifetime: null, remaining: null, notice: null });
  });

  test("the DTO's names and the column names read the same; malformed values are null", () => {
    const dto = readLifecycle({ ...BASE, requestedTtlSeconds: 3600 });
    const row = readLifecycle({
      expires_at: BASE.expiresAt,
      effective_ttl_seconds: BASE.effectiveTtlSeconds,
      requested_ttl_seconds: 3600,
      last_observed_at: BASE.lastObservedAt,
      lifecycle_error: null,
    });
    expect(row).toEqual(dto);
    expect(readLifecycle({ expiresAt: "soon", effectiveTtlSeconds: -1, lifecycleError: "  " })).toMatchObject({
      expiresAt: null,
      effectiveTtlSeconds: null,
      lifecycleError: null,
    });
  });

  test("a live sandbox before its deadline shows its lifetime and what is left", () => {
    expect(lifecycleView("running", BASE, NOW)).toEqual({
      lifetime: "8 h (default)",
      remaining: "1 h 20 min left",
      notice: null,
    });
    expect(lifecycleView("ready", { ...BASE, requestedTtlSeconds: 86_400 }, NOW).lifetime).toBe("8 h (requested 1 d)");
    expect(lifecycleView("ready", { ...BASE, requestedTtlSeconds: 8 * 3600 }, NOW).lifetime).toBe("8 h");
  });

  test("past the deadline a live sandbox is overdue, not stopped; a failed stop is retried", () => {
    const late = { ...BASE, expiresAt: "2026-11-09T11:00:00Z" };
    const overdue = lifecycleView("running", late, NOW);
    expect(overdue.remaining).toBeNull();
    expect(overdue.notice?.kind).toBe("overdue");
    expect(overdue.notice?.text).toContain("once the provider confirms");

    const retrying = lifecycleView("stopping", { ...late, lifecycleError: "The provider timed out." }, NOW);
    expect(retrying.notice?.kind).toBe("retrying");
    expect(retrying.notice?.text).toContain("The provider timed out.");
  });

  test("a stopped, failed or deleted sandbox has no countdown and no notice, whatever its deadline", () => {
    for (const status of ["stopped", "failed", "deleted"] as const) {
      const view = lifecycleView(status, { ...BASE, expiresAt: "2026-11-09T11:00:00Z", lifecycleError: "x" }, NOW);
      expect(view).toEqual({ lifetime: "8 h (default)", remaining: null, notice: null });
    }
  });

  test("durations use at most two whole units", () => {
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(2 * 3600 + 5 * 60 + 59)).toBe("2 h 5 min");
    expect(formatDuration(3 * 86_400 + 4 * 3600 + 120)).toBe("3 d 4 h");
    expect(formatDuration(2 * 86_400)).toBe("2 d");
  });
});
