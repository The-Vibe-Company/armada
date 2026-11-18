import { expect, test } from "bun:test";
import { launch } from "@armada/core/contract";

const schema = launch.input.body;
const id = "12345678-1234-1234-1234-123456789abc";
const key = "launch/example".padEnd(16, "_");
const boat = { provider: "boat", golden: "work", harness: "codex" };
const modal = { ...boat, provider: "modal" };
const pinned = {
  provider: "modal",
  harness: "claude",
  runtimeVersion: 1,
  runtimeTransport: "dialout",
  id,
  revision: 1,
  requestKey: "launch-1",
};
const docker = { provider: "docker", hostId: id, harness: "opencode", idempotencyKey: key };

test.each([
  ["Boat default", boat],
  ["Boat runtime", { ...boat, boatRuntime: true, runtimeVersion: 1 }],
  ["Modal default", modal],
  ["Modal dial-out", { ...modal, runtimeTransport: "dialout", runtimeVersion: 1 }],
  ["pinned Modal template", pinned],
  ["Docker host", docker],
  ["Docker snapshot", { provider: "docker", snapshotId: id, requestId: id, harness: "codex" }],
] as const)("%s accepts a slug, UUID, or omitted org with an explicit harness", (_name, input) => {
  for (const org of [undefined, "team-slug", id]) {
    expect(schema.safeParse({ ...input, org }).success).toBe(true);
  }
  expect(schema.safeParse({ ...input, harness: undefined }).success).toBe(false);
});

test.each([
  ["missing provider", { ...boat, provider: undefined }],
  ["unknown provider", { ...boat, provider: "unknown" }],
  ["blank organization", { ...docker, org: " " }],
  ["Boat runtime selectors on Modal", { ...modal, boatRuntime: true, runtimeVersion: 1 }],
  ["pinned revision mixed with a golden", { ...pinned, golden: "work" }],
  ["pinned revision with an account override", { ...pinned, credentialId: id }],
  ["Docker missing source", { ...docker, hostId: undefined }],
  ["Docker snapshot with repository overrides", { ...docker, snapshotId: id, repos: [] }],
  ["Docker with both replay identities", { ...docker, requestId: id }],
  ["Docker with a size override", { ...docker, size: "small" }],
  ["Docker with scoped access", { ...docker, armadaAccess: true }],
  ["Docker with org visibility", { ...docker, visibility: "org" }],
  ["Docker prompt exceeding the UTF-8 limit", { ...docker, prompt: "é".repeat(131073) }],
  ["Modal TTL beyond its provider limit", { ...modal, ttlSeconds: 86401 }],
] as const)("rejects %s", (_name, input) => {
  expect(schema.safeParse(input).success).toBe(false);
});
