import { expect, test } from "bun:test";
import { sandboxControlRefusal } from "./sandbox-control-refusal.ts";

const now = new Date("2026-11-16T00:00:00Z");
test("terminal controls refuse with provider recovery guidance", () => {
  for (const status of ["stopped", "failed", "expired", "deleted", "removed"]) {
    for (const provider of ["docker", "boat", "modal"]) {
      const result = sandboxControlRefusal({ status, provider }, now, "exec");
      expect(result).toContain(status);
      expect(result).toContain(provider);
      expect(result).toContain("same branch");
    }
  }
  expect(
    sandboxControlRefusal({ status: "stopped", provider: "modal", runtimeTransport: "dialout" }, now, "exec"),
  ).toContain("Send a message");
});
test("live and retained idle sandboxes stay usable only before expiry", () => {
  for (const status of ["ready", "running", "stopped"]) {
    const sandbox = { status, provider: "modal", statusReason: "idle_paused", expiresAt: "2026-11-17T00:00:00Z" };
    expect(sandboxControlRefusal(sandbox, now)).toBeNull();
    expect(sandboxControlRefusal({ ...sandbox, expiresAt: now.toISOString() }, now)).toContain("expired");
  }
});

test("only send resumes preserved stopped cloud sandboxes", () => {
  for (const provider of ["boat", "modal", "docker"]) {
    for (const operation of ["send", "steer", "exec", "interrupt"]) {
      const row = { provider, status: "stopped" };
      expect(sandboxControlRefusal(row, now, operation) === null).toBe(operation === "send" && provider !== "docker");
      expect(
        sandboxControlRefusal({ ...row, preservationNote: "checkpoint_failed_disk_not_retained" }, now, operation),
      ).not.toBeNull();
    }
  }
});
