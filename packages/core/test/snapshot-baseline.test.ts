import { expect, test } from "bun:test";
import { snapshotBaselineInstall, snapshotBaselineInstallFailure } from "../src/snapshot-baseline.ts";

test("snapshot archive checksum records use bare filenames", () => {
  const checks = snapshotBaselineInstall().match(/echo "[^"]+" \| sha256sum -c -/g);
  expect(checks).toEqual([
    'echo "$node_sha  node.tar.xz" | sha256sum -c -',
    expect.stringMatching(/^echo "[a-f0-9]{64} {2}git\.tar\.xz" \| sha256sum -c -$/),
  ]);
});

test.each([
  [
    "credential-shaped provider output\nARMADA_BASELINE_INSTALL_FAILED sha256sum -c (Node archive)\n",
    "Snapshot baseline installation failed: sha256sum -c (Node archive) exited 1.",
  ],
  [
    "ARMADA_BASELINE_INSTALL_FAILED unrecognized command with private arguments\n",
    "Snapshot baseline installation failed: builder baseline shell (bash or sudo -n bash) exited 1.",
  ],
])("baseline failure details contain only known command names", (stderr, message) => {
  expect(
    snapshotBaselineInstallFailure({
      detached: false,
      exitCode: 1,
      stdout: "",
      stderr,
      timedOut: false,
      truncated: false,
    }),
  ).toBe(message);
});
