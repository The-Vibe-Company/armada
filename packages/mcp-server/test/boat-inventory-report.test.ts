import { expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import { reportBoatInventory } from "../src/boat-inventory-report.ts";

test("reports unique deployment-scoped Boat sandboxes against canonical ownership across pages", async () => {
  const owned = { sandboxId: "owned", deploymentId: "prod", createdAt: new Date(0) };
  const sql: Sql = {
    async query<T>(_statement: string, params?: unknown[]) {
      const ids = params?.[0] as string[];
      return { rows: ids.filter((id) => id === "owned").map((id) => ({ provider_sandbox_id: id }) as T) };
    },
  };
  const report = await reportBoatInventory(
    sql,
    {
      async listSandboxInventory(request) {
        return request?.cursor === "next"
          ? { items: [owned, { ...owned, sandboxId: "unmatched" }], cursor: null }
          : { items: [owned, { ...owned, sandboxId: "foreign", deploymentId: "other" }], cursor: "next" };
      },
    },
    "prod",
  );
  expect(report).toEqual({ observed: 2, matched: 1, unmatched: 1 });
});

test("rejects a cyclic Boat inventory instead of reporting partial counts", async () => {
  const sql: Sql = {
    async query() {
      throw new Error("No ownership lookup expected for an empty page.");
    },
  };
  await expect(
    reportBoatInventory(
      sql,
      {
        async listSandboxInventory(request) {
          return { items: [], cursor: request?.cursor === "first" ? "second" : "first" };
        },
      },
      "prod",
    ),
  ).rejects.toThrow("Boat inventory repeated a page cursor.");
});
