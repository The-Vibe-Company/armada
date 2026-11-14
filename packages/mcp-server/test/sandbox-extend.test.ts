import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { type Provider, ProviderError, type SandboxPatch, type SandboxRecord, type SandboxStore } from "@armada/core";
import { extendSandbox } from "../src/sandbox-extend.ts";

const NOW = "2026-11-13T12:00:00.000Z";
beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => setSystemTime());

function fixture() {
  const sandbox: SandboxRecord = {
    id: "logical",
    provider: "modal",
    providerSandboxId: "physical",
    goldenId: "golden",
    orgId: "org",
    ownerId: "owner",
    harness: "codex",
    status: "ready",
    conversationIds: ["retained"],
    createdAt: NOW,
    stoppedAt: null,
    deletedAt: null,
    statusReason: null,
    repositoryDir: null,
    model: "gpt-test",
    reasoningEffort: "high",
    expiresAt: "2026-11-13T12:05:00.000Z",
    lifecycleGeneration: 3,
  };
  const patches: SandboxPatch[] = [];
  const store = {
    update: async (_id: string, patch: SandboxPatch) => {
      patches.push(patch);
    },
  } as SandboxStore;
  return { sandbox, patches, store };
}

// The service policy is deterministic here; adapter wire behavior and full lifecycle belong to their owners/smoke.
test("extension confirms provider headroom before publishing the logical deadline and renewing leases", async () => {
  for (const status of ["ready", "running"] as const) {
    const f = fixture();
    f.sandbox.status = status;
    const calls: unknown[] = [];
    let renewals = 0;
    const provider = {
      id: "modal" as const,
      extendLifetime: async (input: unknown) => {
        calls.push(input);
        return new Date("2026-11-13T12:25:00.000Z");
      },
    } as Provider;
    const result = await extendSandbox(f.store, f.sandbox, provider, 1200, async () => {
      renewals++;
    });
    expect(calls).toEqual([{ sandboxId: "physical", ttlSeconds: 1500 }]);
    expect(result).toEqual({ id: "logical", expiresAt: "2026-11-13T12:20:00.000Z", ttlSeconds: 1200 });
    expect(f.patches.at(-1)).toMatchObject({
      expiresAt: "2026-11-13T12:20:00.000Z",
      effectiveTtlSeconds: 1200,
      finishActivity: true,
    });
    expect(renewals).toBe(1);
  }
});

test("a physical cap below the retained deadline schedules stop and releases the preservation-blocking lease", async () => {
  const f = fixture();
  let renewed = false;
  const provider = {
    id: "modal",
    extendLifetime: async (_input: unknown) => new Date("2026-11-13T12:04:00.000Z"),
  } as Provider;
  await expect(
    extendSandbox(f.store, f.sandbox, provider, 1200, async () => {
      renewed = true;
    }),
  ).rejects.toMatchObject({ code: "extension_state" });
  expect(f.patches.at(-1)).toMatchObject({
    status: "stopping",
    statusReason: "expired",
    expiresAt: NOW,
    stopRequested: true,
    finishActivity: true,
  });
  expect(renewed).toBe(false);
});

test("a definite physical refusal preserves the old logical deadline and releases activity ownership", async () => {
  const f = fixture();
  const provider = {
    id: "modal" as const,
    extendLifetime: async (_input: unknown): Promise<Date> => {
      throw new ProviderError({
        provider: "modal",
        code: "invalid_request",
        message: "Physical cap",
        retryable: false,
      });
    },
  } as Provider;
  await expect(extendSandbox(f.store, f.sandbox, provider, 1200)).rejects.toMatchObject({ code: "extension_maximum" });
  expect(f.patches.at(-1)).toMatchObject({ finishActivity: true });
  expect(f.patches.some((patch) => patch.expiresAt !== undefined)).toBe(false);
});
