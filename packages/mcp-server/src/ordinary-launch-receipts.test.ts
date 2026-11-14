import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core";
import type { Provider } from "@armada/core/server";
import { PGlite } from "@electric-sql/pglite";
import { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";

const db = new PGlite();
beforeAll(async () => {
  await db.waitReady;
});
afterAll(async () => {
  await db.close();
});

// Real unique constraint/JSON persistence; no provider network or launch retry mock.
test("ordinary receipts fence uncertain dispatch, recover labels and replay a lost successful response", async () => {
  await db.exec(`CREATE TABLE ordinary_launch_receipts (
      id uuid PRIMARY KEY, org_id text, owner_id text, request_key text,
      fingerprint text, response jsonb, UNIQUE(org_id,owner_id,request_key));`);
  const receipts = createOrdinaryLaunchReceipts(db as unknown as Sql);
  const actor = { orgId: "org", userId: "owner" };
  let allocations = 0;
  let handle = "";
  const key = "uncertain-launch-key";
  const dispatch = async (id: string) => {
    allocations++;
    handle = id;
    throw new Error("allocation succeeded; response lost");
  };
  await expect(receipts.run(actor, key, { golden: "g" }, dispatch)).rejects.toThrow("outcome unknown");
  await expect(receipts.run(actor, key, { golden: "g" }, dispatch)).rejects.toThrow(handle);
  expect(allocations).toBe(1);
  await expect(receipts.run(actor, key, { golden: "different" }, dispatch)).rejects.toThrow("conflicts");
  const provider = {
    list: async () => ({
      items: [{ id: "physical", state: "running", labels: { sandbox: handle, org: "org", owner: "owner" } }],
      cursor: null,
    }),
  } as unknown as Provider;
  expect((await receipts.inspect(actor, handle, provider)).allocations).toEqual([{ id: "physical", state: "running" }]);
  await expect(receipts.inspect({ ...actor, userId: "other" }, handle, provider)).rejects.toThrow("not found");
  const complete = async (id: string) => {
    allocations++;
    return { id, status: "running" };
  };
  const first = await receipts.run(actor, "successful-launch-key", { golden: "g" }, complete);
  expect(await receipts.run(actor, "successful-launch-key", { golden: "g" }, complete)).toEqual(first);
  expect(allocations).toBe(2);
});
