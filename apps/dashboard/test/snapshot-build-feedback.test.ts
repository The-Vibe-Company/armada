import { expect, test } from "bun:test";
import type { GoldenBuildStatus } from "@armada/core";
import { snapshotBuildFeedback } from "../src/lib/snapshot-build-feedback";

const build: GoldenBuildStatus = {
  jobId: "11111111-1111-4111-8111-111111111111",
  provider: "modal",
  state: "running",
  phase: "internal_phase",
  errorCode: null,
  result: null,
};

test("progress and success describe the snapshot without job, phase or snapshot identifiers", () => {
  expect(snapshotBuildFeedback({ ...build, state: "queued" }, "create")).toMatchObject({
    ok: true,
    message: expect.stringContaining("queued"),
  });
  expect(snapshotBuildFeedback(build, "create")).toEqual({ ok: true, message: "Snapshot build is running." });
  const success = snapshotBuildFeedback(
    { ...build, state: "succeeded", result: { name: "example", visibility: "org", snapshot: "sha256:example" } },
    "update",
  );
  expect(success).toMatchObject({ ok: true, message: expect.stringContaining("Rebuilt Modal snapshot 'example'") });
  expect(JSON.stringify(success)).not.toContain("sha256:");
  expect(JSON.stringify(success)).not.toContain(build.jobId);
});

test("failure hides diagnostics and never invents a retained previous snapshot", () => {
  const failure = snapshotBuildFeedback(
    {
      ...build,
      state: "failed",
      errorCode: "build_failed",
      failureReason: "detail:HTTP 503 snapshot_id digest sha256:example",
    },
    "create",
  );
  expect(failure).toMatchObject({ ok: false, error: expect.stringContaining("administrator") });
  expect(JSON.stringify(failure)).not.toMatch(/HTTP|snapshot_id|sha256|retained|internal_phase/);
});

test("recovery-required capacity is never presented as permission to retry", () => {
  const result = snapshotBuildFeedback(
    { ...build, state: "recovery_required", errorCode: "build_failed", failureReason: "provider_payment_required" },
    "update",
  );
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Capacity is still reserved") });
  expect(JSON.stringify(result)).not.toContain("try again");
});

test("a confirmed pre-builder cancellation is not presented as an unexplained build failure", () => {
  expect(
    snapshotBuildFeedback(
      {
        ...build,
        state: "failed",
        phase: "queued",
        failureReason:
          "detail:Build cancelled by its owner before a builder started. Start a new build request when ready.",
      },
      "create",
    ),
  ).toMatchObject({ ok: true, message: expect.stringContaining("No builder was started") });
});
