import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderTarget, Sql } from "@armada/core";
import { GoldenError, LaunchError, type Provider, ProviderError, VaultError } from "@armada/core/server";
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
      fingerprint text, response jsonb, failure jsonb, authority jsonb, UNIQUE(org_id,owner_id,request_key));
    CREATE TABLE provider_launch_requests (sandbox_id uuid,phase text,fence_id uuid,outcome jsonb);
    CREATE TABLE sandboxes (id uuid,org_id text,owner_id text,status text);`);
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
  const provider = {
    backendIdentity: async () => ({ id: "original" }),
    managementIdentity: async () => ({ scope: "org", ownerId: "org" }),
    list: async () => ({
      items: [{ id: "physical", state: "running", labels: { sandbox: handle, org: "org", owner: "owner" } }],
      cursor: null,
    }),
  } as unknown as Provider;
  expect((await receipts.inspect(actor, handle, async () => provider)).allocations).toEqual([
    { id: "physical", state: "running" },
  ]);
  await expect(receipts.inspect({ ...actor, userId: "other" }, handle, async () => provider)).rejects.toThrow(
    "not found",
  );
  // Replace the caller's current golden binding after admission. Inspection must
  // deserialize its own original target, not retain or accept this mutable object.
  authority.target.provider = "modal";
  authority.target.visibility = "private";
  const seen: unknown[] = [];
  expect(
    (
      await receipts.inspect(actor, handle, async (target) => {
        seen.push(target);
        return provider;
      })
    ).allocations,
  ).toEqual([{ id: "physical", state: "running" }]);
  expect(seen).toEqual([{ provider: "boat", orgId: "org", visibility: "org", modal: null }]);
  let queriedReplacement = false;
  const replacement = {
    backendIdentity: async () => ({ id: "replacement" }),
    list: async () => {
      queriedReplacement = true;
      return { items: [], cursor: null };
    },
  } as unknown as Provider;
  expect((await receipts.inspect(actor, handle, async () => replacement)).outcome).toBe("authority_blocked");
  expect(queriedReplacement).toBe(false);
  expect(
    (
      await receipts.inspect(actor, handle, async () => {
        throw new Error("revoked");
      })
    ).outcome,
  ).toBe("authority_blocked");
  const fallback = { ...provider, managementIdentity: async () => ({ scope: "user", ownerId: "owner" }) } as Provider;
  expect((await receipts.inspect(actor, handle, async () => fallback)).outcome).toBe("authority_blocked");
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

test("known terminal refusals replay typed failures without redispatch or provider inspection", async () => {
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
    let id = "";
    const dispatch = async (receiptId: string) => {
      calls++;
      id = receiptId;
      throw error;
    };
    const key = `terminal-refusal-key-${index}`;
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toBe(error);
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toBeInstanceOf(error.constructor);
    await expect(receipts.run(actor, key, {}, dispatch, authority)).rejects.toMatchObject({ code: error.code });
    expect(calls).toBe(1);
    const inspection = await receipts.inspect(actor, id, async () => {
      throw new Error("must not resolve");
    });
    expect(inspection.outcome).toBe("failed");
    expect(JSON.stringify(inspection)).not.toContain("unsafe upstream body");
    await expect(receipts.run(actor, key, { changed: true }, dispatch, authority)).rejects.toThrow("conflicts");
  }
});

test("post-allocation launch failures remain uncertain and inspectable", async () => {
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
