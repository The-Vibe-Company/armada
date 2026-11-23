import { expect, test } from "bun:test";
import { snapshotBaselineInstall, snapshotBaselineInstallFailure } from "../src/snapshot-baseline.ts";

test("snapshot archive checksum records use bare filenames", () => {
  const records = snapshotBaselineInstall()
    .split("; ")
    .filter((step) => step.includes("| sha256sum -c -"))
    .map((step) => step.split("| sha256sum -c -")[0]);
  expect(records).toEqual([expect.stringContaining("node.tar.xz"), expect.stringContaining("git.tar.xz")]);
  // Two backslashes in the shell format leave a literal backslash-n in the filename.
  for (const record of records) expect(record).not.toContain("\\\\n");
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
