import { expect, test } from "bun:test";
import { dockerLaunchOption } from "../src/lib/docker-launch.ts";
import {
  hasDockerHost,
  snapshotCurrentVersion,
  snapshotLaunchEnabled,
  snapshotRebuildAvailable,
  snapshotState,
} from "../src/lib/docker-snapshots.ts";

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

test("rebuild offers require a newer stable server, a ready available host, build discovery and the right publisher", () => {
  const snapshot = {
    status: "ready" as const,
    hostAvailable: true,
    visibility: "private" as "private" | "org",
    ownerId: "owner",
    builtOnVersion: "1.2.3",
  };
  const owner = { id: "owner", isAdmin: false };
  expect(snapshotRebuildAvailable(snapshot, "1.3.0", owner, true)).toBe(true);
  for (const currentVersion of [null, "1.2.3", "1.2.2", "1.3.0-beta.1"])
    expect(snapshotRebuildAvailable(snapshot, currentVersion, owner, true)).toBe(false);
  for (const fields of [
    { status: "building" as const },
    { status: "failed" as const },
    { hostAvailable: false },
    { builtOnVersion: null },
  ])
    expect(snapshotRebuildAvailable({ ...snapshot, ...fields }, "1.3.0", owner, true)).toBe(false);
  expect(snapshotRebuildAvailable(snapshot, "1.3.0", owner, false)).toBe(false);
  expect(snapshotRebuildAvailable(snapshot, "1.3.0", { id: "other", isAdmin: true }, true)).toBe(false);
  expect(snapshotRebuildAvailable({ ...snapshot, visibility: "org" }, "1.3.0", owner, true)).toBe(false);
  expect(
    snapshotRebuildAvailable({ ...snapshot, visibility: "org" }, "1.3.0", { id: "admin", isAdmin: true }, true),
  ).toBe(true);
});

test("snapshot list metadata tolerates older servers without offering malformed current versions", () => {
  expect(snapshotCurrentVersion("1.2.3")).toBe("1.2.3");
  for (const value of [undefined, null, 123, {}, "", "1.2", "v1.2.3", "1.2.3-beta", "01.2.3"])
    expect(snapshotCurrentVersion(value)).toBeNull();
});
