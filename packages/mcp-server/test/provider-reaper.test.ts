import { expect, test } from "bun:test";
import type { ProviderInventoryMachine } from "@armada/core";
import { createProviderReaper, decideInventoryMachine, type ProviderReaperSource } from "../src/provider-reaper.ts";

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

  expect(reads).toBe(2);
  expect(attempts).toBe(2);
  expect(records).toContainEqual({
    metric: "reaper_unknown_machines",
    provider: "modal",
    count: 1,
    overdue: 1,
    complete: true,
  });
  expect(
    records.filter(
      (record) =>
        (record as { count?: number; metric?: string }).metric === "reaper_deleted" &&
        (record as { count?: number }).count === 1,
    ),
  ).toEqual([{ metric: "reaper_deleted", provider: "modal", reason: "unknown", count: 1 }]);
});

test("cancellation during ownership lookup prevents deletion", async () => {
  const controller = new AbortController();
  let deletes = 0;
  const lane = createProviderReaper(
    {
      provider: "modal",
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
    () => {},
    () => now,
  );

  await lane.reconcileOne(controller.signal);

  expect(deletes).toBe(0);
});
