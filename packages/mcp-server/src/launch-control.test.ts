import { expect, test } from "bun:test";
import type { GoldenRecord, VaultStore } from "@armada/core";
import type { Caller } from "./caller.ts";
import type { ScopedData } from "./data.ts";
import { launchActor } from "./launch-control.ts";

const golden = (orgId: string, name: string) =>
  ({
    id: crypto.randomUUID(),
    orgId,
    ownerId: "owner-1",
    name,
    visibility: "org",
    provider: "modal",
    providerSandboxId: null,
    providerSnapshotId: "snap-1",
    modal: { workspace: "app:ap-1", environment: "main", appId: "ap-1" },
    config: { repos: [], init: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
  }) satisfies GoldenRecord;

test("launchActor avoids duplicate golden fetches and queries multiple orgs in parallel", async () => {
  const [orgA, orgB, orgC] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const singleRecord = golden(orgA, "shared");
  let singleCalls = 0;
  const singleData = {
    goldens: {
      findByName: async () => {
        singleCalls++;
        return [singleRecord];
      },
    },
  } as unknown as ScopedData;
  const singleCaller: Caller = { userId: "owner-1", orgs: [{ orgId: orgA, role: "member" }], via: "service" };
  expect(await launchActor(singleData, singleCaller, "shared", undefined, {} as VaultStore)).toEqual({
    actor: { userId: "owner-1", orgId: orgA, role: "member" },
    golden: singleRecord,
  });
  expect(singleCalls).toBe(1);

  const multiRecord = golden(orgB, "shared");
  let multiCalls = 0,
    inFlight = 0,
    maxInFlight = 0;
  const allStarted = Promise.withResolvers<void>();
  const multiData = {
    goldens: {
      async findByName(orgId: string) {
        multiCalls++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        if (inFlight === 3) allStarted.resolve();
        await allStarted.promise;
        inFlight--;
        return orgId === orgB ? [multiRecord] : [];
      },
    },
  } as unknown as ScopedData;
  const multiCaller: Caller = {
    userId: "owner-1",
    orgs: [
      { orgId: orgA, role: "member" },
      { orgId: orgB, role: "admin" },
      { orgId: orgC, role: "member" },
    ],
    via: "service",
  };
  expect(await launchActor(multiData, multiCaller, "shared", undefined, {} as VaultStore)).toEqual({
    actor: { userId: "owner-1", orgId: orgB, role: "admin" },
    golden: multiRecord,
  });
  expect([maxInFlight, multiCalls]).toEqual([3, 3]);

  const ambiguousData = {
    goldens: { findByName: async (orgId: string, name: string) => [golden(orgId, name)] },
  } as unknown as ScopedData;
  await expect(launchActor(ambiguousData, multiCaller, "shared", undefined, {} as VaultStore)).rejects.toMatchObject({
    code: "invalid",
    message: "Name the org for this golden.",
  });
});
