import { expect, test } from "bun:test";
import { type GoldenRecord, goldenResponse } from "../src/index.ts";

test.each(["boat", "modal"] as const)("%s public golden metadata exposes generic provider identifiers", (provider) => {
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
  const response = goldenResponse(row);
  expect(response).toMatchObject({
    provider,
    providerSnapshotId: "snapshot",
    providerSandboxId: "builder",
  });
  expect(response).not.toHaveProperty("createdAt");
  expect(response).not.toHaveProperty("boatSnapshotId");
  expect(response).not.toHaveProperty("boatSandboxId");
});
