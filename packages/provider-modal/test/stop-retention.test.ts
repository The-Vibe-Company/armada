import { expect, test } from "bun:test";
import type { ModalClient } from "modal";
import {
  createModalProvider,
  type Machine,
  type ModalStore,
  type RunnerDistribution,
  type Scope,
} from "../src/index.ts";

/** Stop-policy boundary: real adapter, injected persistence/SDK ports; no SQL startup. */
function fixture(stage: "scrub" | "snapshot") {
  const scope: Scope = {
    orgId: "org",
    userId: "owner",
    visibility: "private",
    binding: { workspace: "workspace", environment: "main", appId: "app" },
  };
  let stored: Machine = {
    info: { id: "logical", name: "worker", state: "running", providerState: "active", labels: {} },
    generation: 1,
    phase: "active",
    physicalId: "physical",
    physicalName: "owned-worker",
    golden: false,
    ttlSeconds: 3600,
    managementAuthority: { credentialScope: "user", credentialOwnerId: "owner" },
    recoveryImageId: "prior-recovery",
  };
  let failing = true,
    terminated = 0,
    snapshots = 0;
  const store = {
    get: async () => structuredClone(stored),
    lease: async <T>(
      _id: string,
      work: (row: Machine, save: (value: Machine) => Promise<void>) => Promise<T>,
    ): Promise<T> =>
      work(structuredClone(stored), async (value) => {
        stored = structuredClone(value);
      }),
    images: async () => [],
    watermark: async () => 1,
  } as unknown as ModalStore;
  const sandbox = {
    snapshotFilesystem: async () => {
      snapshots++;
      if (failing && stage === "snapshot") throw Error("snapshot outcome unknown");
      return { imageId: "fresh-recovery" };
    },
    terminate: async () => {
      terminated++;
    },
    poll: async () => (terminated ? 0 : null),
  };
  const client = {
    apps: { fromName: async () => ({ appId: "app" }) },
    sandboxes: { fromId: async () => sandbox },
  } as unknown as ModalClient;
  const distribution = {
    capabilities: {},
    prepareSnapshot: async () => {
      if (failing && stage === "scrub") throw Error("scrub refused");
    },
  } as unknown as RunnerDistribution;
  const provider = createModalProvider({
    scope,
    appName: "bound",
    client,
    store,
    distribution,
    runner: { call: async <T>() => ({ generation: "1", watermark: 1, acknowledgedSequence: 1 }) as T },
  });
  return {
    provider,
    state: () => stored,
    snapshots: () => snapshots,
    terminated: () => terminated,
    recover: () => {
      failing = false;
    },
  };
}

test.each(["scrub", "snapshot"] as const)(
  "retention-required idle stop never discards workspace after %s failure",
  async (stage) => {
    const f = fixture(stage);
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    expect(f.terminated()).toBe(0);
    expect(f.state().phase).toBe(stage === "scrub" ? "checkpoint" : "snapshot");
    expect(f.state().recoveryImageId).toBe("prior-recovery");
    expect(f.state().info.stopNote).toBeUndefined();
    expect(f.snapshots()).toBe(stage === "snapshot" ? 1 : 0);
    if (stage === "scrub") {
      f.recover();
      await f.provider.stop({ sandboxId: "logical", requireRetention: true });
      expect(f.terminated()).toBe(1);
      expect(f.state().phase).toBe("stopped");
      expect(f.state().recoveryImageId).toBe("fresh-recovery");
      expect(f.state().info.stopNote).toBeUndefined();
    }
  },
);

test.each(["common-runtime", "lost-workspace", "unretained-terminate"] as const)(
  "retention policy refuses compute-only state (%s)",
  async (mode) => {
    const f = fixture("snapshot");
    if (mode === "common-runtime") f.state().commonRuntime = true;
    if (mode === "lost-workspace") f.state().info.stopNote = "checkpoint_failed_disk_not_retained";
    if (mode === "unretained-terminate") {
      f.state().phase = "terminate";
      delete f.state().recoveryImageId;
    }
    await expect(f.provider.stop({ sandboxId: "logical", requireRetention: true })).rejects.toThrow();
    expect(f.terminated()).toBe(0);
    expect(f.snapshots()).toBe(0);
  },
);
