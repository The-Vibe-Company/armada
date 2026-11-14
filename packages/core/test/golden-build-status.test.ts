import { expect, test } from "bun:test";
import { type GoldenBuildStatus, goldenBuildFailureText } from "../src/golden-build-status.ts";

test.each([
  [
    "authorization",
    "detail:GitHub cannot read acme/private with your connection — grant the Armada GitHub App access to it, then rebuild",
    "GitHub cannot read acme/private",
  ],
  ["checkout_baseline", "detail:Init command 2 exited 17.", "Init command 2 exited 17."],
  [
    "secret_scan",
    "detail:Secret scan found credentials in the builder; remove them before rebuilding.",
    "Secret scan found credentials",
  ],
  ["snapshot", null, "The operation did not complete"],
])("failed status explains phase %s without reducing it to build_failed", (phase, failureReason, expected) => {
  const status: GoldenBuildStatus = {
    jobId: "job",
    phase,
    failureReason,
    state: "failed",
    errorCode: "build_failed",
    result: null,
  };
  const text = goldenBuildFailureText(status);
  expect(text).toContain(`Build failed at ${phase}`);
  expect(text).toContain(expected);
  expect(text).not.toContain("build_failed");
});

test("recovery status keeps the diagnostic but does not advise an unsafe retry", () => {
  expect(
    goldenBuildFailureText({
      jobId: "job",
      phase: "snapshot",
      failureReason: "detail:Snapshot verification failed.",
      state: "recovery_required",
      errorCode: "build_failed",
      result: null,
    }),
  ).toContain("Snapshot verification failed. Recovery required; capacity is still held.");
});
