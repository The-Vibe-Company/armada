import { expect, test } from "bun:test";
import type { GoldenRecord } from "../src/golden.ts";
import { assertGoldenBackendBinding, sqlGoldenBackendSlots } from "../src/golden-create.ts";
import type { Sql } from "../src/golden-store.ts";
import type { Provider } from "../src/provider.ts";

const golden = { id: "golden", provider: "boat" } as GoldenRecord;
const provider = { id: "boat", maxGoldens: 1 } as Provider;

test.each([
  [[], "not bound to the connected provider account"],
  [[{ busy: true }], "reservation with no durable job"],
  [[{ busy: true, job_id: "job", started_at: "2026-11-14 10:00:00+00" }], "armada golden build-status job"],
] as const)("binding preflight distinguishes missing binding from busy reservation (%j)", async (rows, message) => {
  const sql = { query: async () => ({ rows }) } as unknown as Sql;
  await expect(assertGoldenBackendBinding(sql, golden, provider, "account")).rejects.toThrow(message);
});

test.each([
  ["golden backend capacity reached", "reached its golden capacity"],
  ["golden backend build already in progress", "still running or awaiting recovery"],
])("slot admission explains %s without conflating causes", async (message, expected) => {
  const sql = {
    query: async () => {
      throw { code: "ERR_POSTGRES_SERVER_ERROR", errno: "P0001", message };
    },
  } as unknown as Sql;
  await expect(
    sqlGoldenBackendSlots(sql).reserveExisting({
      provider: "boat",
      backendId: "account",
      capacity: 1,
      goldenId: "golden",
    }),
  ).rejects.toThrow(expected);
});

test("a golden binding uniqueness conflict is not reported as capacity exhaustion", async () => {
  const sql = {
    query: async () => {
      throw {
        code: "23505",
        schema: "public",
        table: "golden_backend_slots",
        constraint: "golden_backend_one_binding",
      };
    },
  } as unknown as Sql;
  await expect(
    sqlGoldenBackendSlots(sql).reserveExisting({
      provider: "boat",
      backendId: "account",
      capacity: 1,
      goldenId: "golden",
    }),
  ).rejects.toThrow("already bound to another backend");
});
