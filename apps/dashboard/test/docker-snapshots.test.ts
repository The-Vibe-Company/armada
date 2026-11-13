import { expect, test } from "bun:test";
import { hasDockerHost, snapshotState } from "../src/lib/docker-snapshots.ts";

test("host-only orgs skip cloud onboarding even while their host is offline, but not after revocation", () => {
  expect(hasDockerHost([])).toBe(false);
  expect(hasDockerHost([{ state: "revoked" }])).toBe(false);
  for (const state of ["pending", "online", "offline"])
    expect(hasDockerHost([{ state: "revoked" }, { state }])).toBe(true);
});

test("only published snapshots on an available installation offer launch; pending and failed builds stay visible", () => {
  expect(snapshotState({ status: "ready", hostAvailable: true })).toMatchObject({ bucket: "ready", label: "Ready" });
  expect(snapshotState({ status: "ready", hostAvailable: false })).toMatchObject({
    bucket: "rest",
    label: "Host unavailable",
  });
  for (const hostAvailable of [true, false]) {
    expect(snapshotState({ status: "building", hostAvailable })).toMatchObject({ bucket: "rest", label: "Building" });
    expect(snapshotState({ status: "failed", hostAvailable })).toMatchObject({
      bucket: "action",
      label: "Build failed",
    });
  }
});
