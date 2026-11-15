import { expect, test } from "bun:test";
import { ProviderError } from "@armada/core/server";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

// The shared HTTP/MCP projection owns this contract; no provider clock or waits.
test("status and list project only persisted logical lifetime, including stopped and unavailable providers", async () => {
  const now = new Date("2026-11-15T12:00:00Z");
  for (const [offset, seconds, soon] of [
    [301000, 301, false],
    [300000, 300, true],
    [1, 1, true],
    [0, 0, true],
    [-1000, 0, true],
    [null, null, false],
  ] as const) {
    for (const state of ["ready", "stopped", "provider_error"] as const) {
      const expiresAt = offset === null ? null : new Date(now.getTime() + offset).toISOString();
      const row = {
        id: "sandbox",
        orgId: "org",
        ownerId: "owner",
        provider: "boat",
        providerSandboxId: "bx",
        boatId: "bx",
        harness: "codex",
        model: null,
        reasoningEffort: null,
        status: state === "stopped" ? "stopped" : "ready",
        statusReason: null,
        visibility: "org",
        golden: "golden",
        repositoryDir: null,
        machineSize: null,
        conversationIds: [],
        createdAt: now.toISOString(),
        stoppedAt: state === "stopped" ? now.toISOString() : null,
        expiresAt,
        effectiveTtlSeconds: null,
        displayLabel: "sandbox",
        canOpen: true,
        canManage: true,
      };
      const context = {
        caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "service" },
        data: {
          sandboxes: { get: async () => row, list: async () => ({ rows: [row], total: 1 }), update: async () => {} },
        },
        now: () => now,
        provider: async () => ({
          get: async () => {
            if (state === "provider_error")
              throw new ProviderError({ provider: "boat", code: "unavailable", retryable: true, message: "offline" });
            return { state: "running", expiresAt: new Date("2026-11-16T12:00:00Z") };
          },
          events: async () => ({ events: [], nextCursor: null }),
        }),
      } as unknown as ToolContext;
      const expected = { expiresAt, timeLeftSeconds: seconds, expiringSoon: soon };
      const list = await callSharedTool(context, "list", {});
      expect((list as { sandboxes: unknown[] }).sandboxes[0]).toMatchObject(expected);
      for (const recorded of [true, false]) {
        const status = await callSharedTool(context, "status", { id: "sandbox", recorded });
        expect(status).toMatchObject(expected);
        expect(status).toHaveProperty(
          "providerExpiresAt",
          !recorded && state !== "provider_error" ? "2026-11-16T12:00:00.000Z" : null,
        );
      }
    }
  }
});
