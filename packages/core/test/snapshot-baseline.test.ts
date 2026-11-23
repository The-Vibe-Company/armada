import { expect, test } from "bun:test";
import { snapshotBaselineInstall, snapshotBaselineInstallFailure } from "../src/snapshot-baseline.ts";

test("a baseline failure cannot expose an unrecognized command from the provider", () => {
  expect(
    snapshotBaselineInstallFailure({
      detached: false,
      exitCode: 17,
      stdout: "",
      stderr: "ARMADA_BASELINE_INSTALL_FAILED unrecognized command with private arguments",
      timedOut: false,
      truncated: false,
    }),
  ).toBe("Snapshot baseline installation failed: builder baseline shell (bash or sudo -n bash) exited 17.");
});

test("baseline provisioning reports the protected path component it refused", () => {
  expect(
    snapshotBaselineInstallFailure({
      detached: false,
      exitCode: 86,
      stdout: "",
      stderr: [
        "ARMADA_OUTPUT_COLLECTOR_FAILURE symlink /opt/armada",
        "ARMADA_BASELINE_INSTALL_FAILED install (Bun directory)",
      ].join("\n"),
      timedOut: false,
      truncated: false,
    }),
  ).toBe(
    "Snapshot baseline installation failed: install (Bun directory) exited 86. Failed check: /opt/armada is a symlink.",
  );
});

test("the image baseline fits on a single Dockerfile RUN instruction", () => {
  expect(snapshotBaselineInstall()).not.toContain("\n");
});
