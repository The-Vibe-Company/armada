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

test("retained Docker idle pauses accept a fresh send but terminal Docker stops do not", () => {
  const row = { provider: "docker", status: "stopped", statusReason: "idle_paused", expiresAt: "2026-11-17T00:00:00Z" };
  expect(sandboxControlRefusal(row, now, "send")).toBeNull();
  // A merge stop is admitted through the same retained idle checkpoint.
  expect(sandboxControlRefusal({ ...row, statusReason: "work_merged" }, now, "send")).toBeNull();
  expect(sandboxControlRefusal({ ...row, statusReason: "agent_finished" }, now, "send")).toContain("same branch");
  for (const operation of ["steer", "exec", "interrupt"])
    expect(sandboxControlRefusal(row, now, operation)).toContain(
      "Send a message to resume its retained idle checkpoint",
    );
  for (const change of [
    { statusReason: null },
    { expiresAt: now.toISOString() },
    { preservationNote: "checkpoint_failed_disk_not_retained" },
  ])
    expect(sandboxControlRefusal({ ...row, ...change }, now, "send")).toContain("same branch");
});
