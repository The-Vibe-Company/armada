import { expect, test } from "bun:test";
import { idlePauseMessage } from "../src/sandbox-access.ts";

test("idle pause wording promises wake only for a confirmed, unexpired idle stop", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const paused = { status: "stopped", idlePaused: true, expiresAt: "2026-11-13T13:00:00Z" };
  expect(idlePauseMessage(paused, now)).toBe("Paused — wakes on your next message");
  for (const change of [
    { status: "stopping" },
    { status: "ready" },
    { status: "failed" },
    { idlePaused: false },
    { expiresAt: now.toISOString() },
    { expiresAt: null },
  ])
    expect(idlePauseMessage({ ...paused, ...change }, now)).toBeNull();
});

test("idle stop reason survives stopped/stopping patches and clears on wake", async () => {
  const { statusReasonOf } = await import("../src/sandbox.ts");
  expect(statusReasonOf({ status: "stopped", statusReason: "idle_paused" })).toBe("idle_paused");
  expect(statusReasonOf({ status: "stopping", statusReason: "idle_paused" })).toBe("idle_paused");
  expect(statusReasonOf({ status: "running", statusReason: "idle_paused" })).toBeNull();
});
