import { expect, test } from "bun:test";
import type { ProviderInventoryMachine, Sql } from "@armada/core";
import { createModalReaperOwnership } from "../src/modal-reaper-ownership.ts";

const machine = {
  sandboxId: "modal_logical",
  machineId: "sb-physical",
  generation: "3",
  deploymentId: "server",
  createdAt: new Date(0),
} satisfies ProviderInventoryMachine;
const binding = { workspace: "work", environment: "env", appId: "ap-bound" };
const signal = new AbortController().signal;
const matching = {
  status: "failed",
  logical_id: machine.sandboxId,
  physical_id: machine.machineId,
  generation: machine.generation,
  same_binding: true,
  same_owner: true,
};

test.each([
  ["provider-only allocation", [{ ...matching, status: null, same_owner: null }], { kind: "absent" }],
  ["exact terminal generation", [matching], { kind: "owned", status: "failed", generation: "3" }],
  ["stale generation tag", [{ ...matching, generation: "4" }], { kind: "owned", status: "failed" }],
  ["different physical ID", [{ ...matching, physical_id: "sb-replacement" }], { kind: "owned", status: "failed" }],
  ["wrong binding", [{ ...matching, same_binding: false }], { kind: "unresolved" }],
  ["different owner", [{ ...matching, same_owner: false }], { kind: "unresolved" }],
  ["reverse mapping conflicts with the tag", [{ ...matching, logical_id: "modal_other" }], { kind: "unresolved" }],
  ["ambiguous provider records", [matching, matching], { kind: "unresolved" }],
])("Modal reaper ownership for %s", async (_name, rows, expected) => {
  const sql: Sql = {
    async query<T>(_statement: string, params?: unknown[]) {
      expect(params).toEqual([
        machine.sandboxId,
        machine.machineId,
        binding.workspace,
        binding.environment,
        binding.appId,
      ]);
      return { rows: rows as T[] };
    },
  };
  const lookup = createModalReaperOwnership(sql, binding);

  expect(await lookup(machine, signal)).toEqual(expected);
});

test("a Modal ownership query failure propagates for the next sweep to retry", async () => {
  const failure = new Error("database read timed out");
  const lookup = createModalReaperOwnership(
    {
      async query() {
        throw failure;
      },
    },
    binding,
  );

  await expect(lookup(machine, signal)).rejects.toBe(failure);
});
