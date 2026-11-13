import { expect, test } from "bun:test";
import { type GoldenRecord, goldenResponse, sandboxIdentity } from "../src/index.ts";

test.each([
  ["boat", "snapshot", "builder"],
  ["modal", null, null],
] as const)("%s public golden aliases never borrow another provider's ids", (provider, snapshot, builder) => {
  const row: GoldenRecord = {
    id: "golden",
    name: "workspace",
    orgId: "org",
    ownerId: "owner",
    visibility: "org",
    provider,
    providerSnapshotId: "snapshot",
    providerSandboxId: "builder",
    modal: null,
    config: { repos: [], init: [] },
    createdAt: "2026-11-13T00:00:00Z",
  };
  expect(goldenResponse(row)).toMatchObject({
    provider,
    providerSnapshotId: "snapshot",
    providerSandboxId: "builder",
    boatSnapshotId: snapshot,
    boatSandboxId: builder,
  });
  expect(goldenResponse(row)).not.toHaveProperty("createdAt");
});

test.each([
  ["boat", "worker"],
  ["modal", null],
  ["docker", null],
] as const)("%s sandbox legacy aliases do not borrow another placement's id", (provider, boatId) => {
  expect(sandboxIdentity({ provider, providerSandboxId: "worker" })).toHaveProperty("boatId", boatId);
});
