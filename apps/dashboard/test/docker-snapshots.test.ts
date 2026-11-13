import { expect, test } from "bun:test";
import { dockerLaunchOption } from "../src/lib/docker-launch.ts";
import { hasDockerHost, snapshotLaunchEnabled, snapshotState } from "../src/lib/docker-snapshots.ts";

test("host-only orgs skip cloud onboarding even while their host is offline, but not after revocation", () => {
  expect(hasDockerHost([])).toBe(false);
  expect(hasDockerHost([{ state: "revoked" }])).toBe(false);
  for (const state of ["pending", "online", "offline"])
    expect(hasDockerHost([{ state: "revoked" }, { state }])).toBe(true);
});

test("only published snapshots on an available installation offer launch; pending and failed builds stay visible", () => {
  expect(snapshotState({ status: "ready", hostAvailable: true }, true)).toMatchObject({
    bucket: "ready",
    label: "Ready",
  });
  expect(snapshotState({ status: "ready", hostAvailable: false }, true)).toMatchObject({
    bucket: "rest",
    label: "Host unavailable",
  });
  expect(snapshotState({ status: "ready", hostAvailable: true }, false)).toMatchObject({
    bucket: "rest",
    label: "Launch unavailable",
  });
  for (const hostAvailable of [true, false]) {
    expect(snapshotState({ status: "building", hostAvailable }, true)).toMatchObject({
      bucket: "rest",
      label: "Building",
    });
    expect(snapshotState({ status: "failed", hostAvailable }, true)).toMatchObject({
      bucket: "action",
      label: "Build failed",
    });
  }
});

test("snapshot affordances require enabled discovery, placement and the golden source, not just a ready catalog row", () => {
  const option = {
    id: "docker" as const,
    enabled: true,
    launchSources: ["golden" as const],
    harnesses: ["codex" as const],
    capabilities: { launch: true, goldens: true },
  };
  // Parsing owns all other capability defaults, as it does for the ordinary host launch.
  const parsed = dockerLaunchOption({ providers: [option] });
  expect(snapshotLaunchEnabled(parsed, true)).toBe(true);
  expect(snapshotLaunchEnabled(null, true)).toBe(false);
  expect(snapshotLaunchEnabled(parsed, false)).toBe(false);
  for (const fields of [
    { enabled: false },
    { launchSources: ["image"] },
    { harnesses: [] },
    { capabilities: { launch: false, goldens: true } },
    { capabilities: { launch: true, goldens: false } },
  ])
    expect(snapshotLaunchEnabled(dockerLaunchOption({ providers: [{ ...option, ...fields }] }), true)).toBe(false);
});
