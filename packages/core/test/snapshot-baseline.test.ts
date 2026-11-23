import { expect, test } from "bun:test";
import { snapshotBaselineInstallFailure } from "../src/snapshot-baseline.ts";

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
