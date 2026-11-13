import { expect, test } from "bun:test";
import { parseDockerSnapshots } from "../src/lib/docker-snapshots.ts";

const hostId = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  id: "22222222-2222-4222-8222-222222222222",
  hostId,
  name: "Work tools",
  officialImageVersion: "2.27.0",
  officialImage: `ghcr.io/the-vibe-company/armada-sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-13T00:00:00Z",
};

// Dashboard owns strict display parsing, not server/RLS visibility or host capture.
test("snapshot metadata keeps built-on versions and strips unknown fields, without confusing failure with an empty list", () => {
  expect(parseDockerSnapshots({ snapshots: [] }, hostId)).toEqual([]);
  expect(parseDockerSnapshots({ snapshots: [{ ...snapshot, extra: "not display data" }] }, hostId)).toEqual([
    { id: snapshot.id, name: "Work tools", builtOnVersion: "2.27.0", createdAt: snapshot.createdAt },
  ]);
  for (const value of [
    null,
    { snapshots: null },
    { snapshots: [snapshot, snapshot] },
    ...[
      { hostId: snapshot.id },
      { name: "bad\nname" },
      { officialImageVersion: "" },
      { officialImage: "custom:latest" },
      { createdAt: "invalid" },
      { id: "not-an-id" },
    ].map((change) => ({ snapshots: [{ ...snapshot, ...change }] })),
  ])
    expect(parseDockerSnapshots(value, hostId)).toBeNull();
});
