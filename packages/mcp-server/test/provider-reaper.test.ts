import { expect, test } from "bun:test";
import type { ProviderInventoryMachine } from "@armada/core";
import {
  createProviderReaper,
  createProviderReaperLane,
  decideInventoryMachine,
  type ProviderReaperSource,
} from "../src/provider-reaper.ts";

const now = Date.UTC(2026, 10, 18);
const grace = 15 * 60_000;
const deploymentId = "staging/server";
const oldMachine: ProviderInventoryMachine = {
  machineId: "machine_old",
  sandboxId: "sandbox_old",
  generation: "physical_1",
  deploymentId,
  createdAt: new Date(now - grace - 1),
};

test("discovery failure emits incomplete sweep evidence and retries on schedule", async () => {
  let time = now;
  let attempts = 0;
  const records: unknown[] = [];
  const lane = createProviderReaperLane(
    async () => {
      if (++attempts === 1) throw new Error("registry unavailable");
      return [];
    },
    (line) => records.push(JSON.parse(line)),
    () => time,
  );
  const signal = new AbortController().signal;

  await lane.reconcileOne(signal);
  await lane.reconcileOne(signal);
  expect(attempts).toBe(1);
  time += 60_000;
  await lane.reconcileOne(signal);
  expect(attempts).toBe(2);
  expect(records).toEqual([{ event: "provider_reaper_retry", phase: "discovery", errors: 1, complete: false }]);
});

test.each([
  ["old orphan", {}, { kind: "absent" }, "unknown"],
  ["at the grace boundary", { createdAt: new Date(now - grace) }, { kind: "absent" }, "unknown_young"],
  ["younger orphan", { createdAt: new Date(now - grace + 1) }, { kind: "absent" }, "unknown_young"],
  ["invalid age", { createdAt: new Date(NaN) }, { kind: "absent" }, "keep"],
  ["foreign deployment", { deploymentId: "production/server" }, { kind: "absent" }, "keep"],
  ["untagged machine", { deploymentId: "" }, { kind: "absent" }, "keep"],
  ["starting owner", {}, { kind: "owned", status: "starting", generation: "physical_1" }, "keep"],
  ["stopped owner", {}, { kind: "owned", status: "stopped", generation: "physical_1" }, "keep"],
  ["matching failed owner", {}, { kind: "owned", status: "failed", generation: "physical_1" }, "terminal"],
  ["matching deleted owner", {}, { kind: "owned", status: "deleted", generation: "physical_1" }, "terminal"],
  ["different generation", {}, { kind: "owned", status: "deleted", generation: "physical_2" }, "keep"],
  ["unproven generation", {}, { kind: "owned", status: "deleted" }, "keep"],
  ["ambiguous ownership", {}, { kind: "unresolved" }, "keep"],
] as const)("%s", (_name, overrides, ownership, expected) => {
  expect(decideInventoryMachine({ ...oldMachine, ...overrides }, deploymentId, ownership, now)).toBe(expected);
});

test("retries provider errors on the next sweep and counts confirmed deletes once", async () => {
  let time = now;
  let attempts = 0;
  let reads = 0;
  let present = true;
  const records: unknown[] = [];
  const source: ProviderReaperSource = {
    provider: "modal",
    sourceId: "account_a",
    deploymentId,
    inventory: {
      async *listInventory() {
        if (present) {
          yield oldMachine;
          yield oldMachine;
        }
        yield { ...oldMachine, machineId: "foreign", deploymentId: "production/server" };
      },
    },
    async lookupOwnership() {
      reads++;
      return { kind: "absent" };
    },
    async deleteMachine() {
      if (++attempts === 1) throw new Error("provider unavailable");
      if (attempts === 2) return false;
      present = false;
      return true;
    },
  };
  const lane = createProviderReaper(
    source,
    (line) => records.push(JSON.parse(line)),
    () => time,
  );
  const signal = new AbortController().signal;

  await lane.reconcileOne(signal);
  await lane.reconcileOne(signal);
  expect(attempts).toBe(1);
  time += 60_000;
  await lane.reconcileOne(signal);
  time += 60_000;
  await lane.reconcileOne(signal);
  time += 60_000;
  await lane.reconcileOne(signal);

  expect(reads).toBe(3);
  expect(attempts).toBe(3);
  expect(records.filter((record) => (record as { event?: string }).event === "reaper_overdue_machines")).toEqual(
    [now, now + 60_000, now + 120_000].map((observedAt) => ({
      event: "reaper_overdue_machines",
      provider: "modal",
      source: "account_a",
      deploymentId,
      observedAt,
      machineIds: [oldMachine.machineId],
    })),
  );
  expect(records).toContainEqual({
    metric: "reaper_unknown_machines",
    provider: "modal",
    source: "account_a",
    count: 1,
    overdue: 1,
    complete: true,
  });
  expect(records).toContainEqual({
    metric: "reaper_deleted",
    provider: "modal",
    source: "account_a",
    reason: "unknown",
    candidates: 1,
    count: 0,
    reportOnly: false,
    complete: false,
  });
  expect(records).toContainEqual({
    metric: "reaper_deleted",
    provider: "modal",
    source: "account_a",
    reason: "unknown",
    candidates: 1,
    count: 0,
    reportOnly: false,
    complete: true,
  });
  expect(
    records.filter(
      (record) =>
        (record as { count?: number; metric?: string }).metric === "reaper_deleted" &&
        (record as { count?: number }).count === 1,
    ),
  ).toEqual([
    {
      metric: "reaper_deleted",
      provider: "modal",
      source: "account_a",
      reason: "unknown",
      candidates: 1,
      count: 1,
      reportOnly: false,
      complete: true,
    },
  ]);
});

test("cancellation during ownership lookup prevents deletion", async () => {
  const controller = new AbortController();
  const records: unknown[] = [];
  let deletes = 0;
  const lane = createProviderReaper(
    {
      provider: "modal",
      sourceId: "account_a",
      deploymentId,
      inventory: {
        async *listInventory() {
          yield oldMachine;
        },
      },
      async lookupOwnership() {
        controller.abort();
        return { kind: "absent" };
      },
      async deleteMachine() {
        deletes++;
        return true;
      },
    },
    (line) => records.push(JSON.parse(line)),
    () => now,
  );

  await lane.reconcileOne(controller.signal);

  expect(deletes).toBe(0);
  expect(records).toContainEqual({
    metric: "reaper_deleted",
    provider: "modal",
    source: "account_a",
    reason: "unknown",
    candidates: 0,
    count: 0,
    reportOnly: false,
    complete: false,
  });
});

test("report-only sources emit distinguishable inventory counts", async () => {
  const records: unknown[] = [];
  const terminal = { ...oldMachine, machineId: "machine_terminal", generation: "physical_terminal" };
  for (const sourceId of ["account_a", "account_b"]) {
    const lane = createProviderReaper(
      {
        provider: "modal",
        sourceId,
        deploymentId,
        inventory: {
          async *listInventory() {
            if (sourceId === "account_a") {
              yield oldMachine;
              yield terminal;
            }
          },
        },
        async lookupOwnership(machine) {
          return machine.machineId === terminal.machineId
            ? { kind: "owned", status: "failed", generation: terminal.generation }
            : { kind: "absent" };
        },
      },
      (line) => records.push(JSON.parse(line)),
      () => now,
    );
    await lane.reconcileOne(new AbortController().signal);
  }
  expect(records).toContainEqual({
    metric: "reaper_unknown_machines",
    provider: "modal",
    source: "account_a",
    count: 1,
    overdue: 1,
    complete: true,
  });
  expect(records).toContainEqual({
    metric: "reaper_unknown_machines",
    provider: "modal",
    source: "account_b",
    count: 0,
    overdue: 0,
    complete: true,
  });
  expect(records).toContainEqual({
    metric: "reaper_deleted",
    provider: "modal",
    source: "account_a",
    reason: "terminal",
    candidates: 1,
    count: 0,
    reportOnly: true,
    complete: true,
  });
});
