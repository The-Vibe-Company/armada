import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderTarget, Sql } from "@armada/core";
import { GoldenError, LaunchError, ProviderError, VaultError } from "@armada/core/server";
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
test("ordinary receipts fence uncertain dispatch and replay a lost successful response", async () => {
  await db.exec(`CREATE TABLE ordinary_launch_receipts (
      id uuid PRIMARY KEY, org_id text, owner_id text, request_key text,
      fingerprint text, response jsonb, failure jsonb, authority jsonb, UNIQUE(org_id,owner_id,request_key));`);
  const receipts = createOrdinaryLaunchReceipts(db as unknown as Sql);
  const actor = { orgId: "org", userId: "owner" };
  const authority: {
    target: ProviderTarget;
    backendId: string;
    management: { scope: "org" | "user"; ownerId: string };
  } = {
    target: { provider: "boat" as const, orgId: "org", visibility: "org" as const, modal: null },
    backendId: "original",
    management: { scope: "org", ownerId: "org" },
  };
  let allocations = 0;
  let handle = "";
  const key = "uncertain-launch-key";
  const dispatch = async (id: string) => {
    allocations++;
    handle = id;
    throw new Error("allocation succeeded; response lost");
  };
  await expect(receipts.run(actor, key, { golden: "g" }, dispatch, authority)).rejects.toThrow("outcome unknown");
  await expect(receipts.run(actor, key, { golden: "g" }, dispatch, authority)).rejects.toThrow(handle);
  expect(allocations).toBe(1);
  await expect(receipts.run(actor, key, { golden: "different" }, dispatch, authority)).rejects.toThrow("conflicts");
  const complete = async (id: string) => {
    allocations++;
    return { id, status: "running" };
  };
  const first = await receipts.run(actor, "successful-launch-key", { golden: "g" }, complete, authority);
  expect(await receipts.run(actor, "successful-launch-key", { golden: "g" }, complete, authority)).toEqual(first);
  expect(allocations).toBe(2);
  await expect(
    receipts.run(
      actor,
      "known-refusal-key",
      {},
      async () => {
        throw new LaunchError("unsupported", "Rebuild the golden.");
      },
      authority,
    ),
  ).rejects.toMatchObject({ code: "unsupported", message: "Rebuild the golden." });
});

test("known terminal refusals replay typed failures without redispatch", async () => {
  const receipts = createOrdinaryLaunchReceipts(db as unknown as Sql);
  const actor = { orgId: "org", userId: "owner" };
  const authority = {
    target: { provider: "boat", orgId: "org", visibility: "org", modal: null } as ProviderTarget,
    backendId: "original",
    management: { scope: "org" as const, ownerId: "org" },
  };
  const errors = [
    new VaultError("missing_credential", "Connect a model account."),
    new GoldenError("conflict", "Golden unavailable."),
    new LaunchError("unsupported", "Rebuild the golden."),
    new ProviderError({
      provider: "boat",
      code: "payment_required",
      message: "unsafe upstream body",
      retryable: false,
    }),
  ];
  for (const [index, error] of errors.entries()) {
    let calls = 0;
    const dispatch = async () => {
      calls++;
      throw error;
    };
    const key = `terminal-refusal-key-${index}`;
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toBe(error);
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toBeInstanceOf(error.constructor);
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toMatchObject({ code: error.code });
    expect(calls).toBe(1);
    if (error instanceof ProviderError) {
      const { rows } = await db.query("SELECT failure FROM ordinary_launch_receipts WHERE request_key=$1", [key]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(error.message);
    }
    await expect(receipts.run(actor, key, { changed: true }, dispatch, authority)).rejects.toThrow("conflicts");
  }
});

test("post-allocation launch failures remain uncertain", async () => {
  const receipts = createOrdinaryLaunchReceipts(db as unknown as Sql);
  const actor = { orgId: "org", userId: "owner" };
  const authority = {
    target: { provider: "boat", orgId: "org", visibility: "org", modal: null } as ProviderTarget,
    backendId: "original",
    management: { scope: "org" as const, ownerId: "org" },
  };
  let calls = 0;
  const dispatch = async () => {
    calls++;
    throw new LaunchError("prompt_failed", "Lost acknowledgement", { sandboxId: "allocated" });
  };
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(receipts.run(actor, "post-allocation-key", {}, dispatch, authority)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  expect(calls).toBe(1);
});
