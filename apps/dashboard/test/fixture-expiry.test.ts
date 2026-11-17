import { expect, test } from "bun:test";
import { sandboxControlRefusal } from "@armada/core";
import { largeSandboxExpiry } from "../e2e/fixture-expiry";

test("Large journey sandboxes accept messages across calendar dates, retaining the expired scenario", () => {
  for (const date of ["2026-11-17T13:41:00Z", "2030-01-01T00:00:00Z"]) {
    const now = new Date(date);
    for (const variant of [1, 4, 8]) {
      const refusal = sandboxControlRefusal(
        {
          provider: "modal",
          status: variant === 4 ? "stopped" : "running",
          statusReason: variant === 4 ? "idle_paused" : null,
          expiresAt: largeSandboxExpiry(variant, now.getTime()),
        },
        now,
      );
      if (variant === 8) expect(refusal).toContain("expired");
      else expect(refusal).toBeNull();
    }
  }
});
