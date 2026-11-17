import { expect, test } from "bun:test";
import { runtimeStartupFailure } from "../src/runtime-startup-failure.ts";

test("startup diagnostics distinguish manifest, availability and integrity without forwarding arbitrary errors", () => {
  for (const [code, expected] of [
    ["runtime_artifact_rename_failed", "artifact_rename"],
    ["runtime_artifact_write_failed", "artifact_write"],
    ["runtime_cache_not_private", "artifact_permission"],
    ["incompatible_harness_manifest", "artifact_manifest_incompatible"],
    ["runtime_artifact_unavailable", "artifact_unavailable"],
    ["runtime_artifact_digest_mismatch", "artifact_integrity"],
    ["runtime_artifact_size_mismatch", "artifact_integrity"],
    ["harness_archive_mismatch", "artifact_integrity"],
    ["private_exception_canary", "artifact_preparation"],
    ["runtime_artifact_unavailable private_exception_canary", "artifact_preparation"],
  ] as const)
    expect(runtimeStartupFailure(new Error(code), "artifact_preparation")).toBe(expected);
  expect(runtimeStartupFailure("runtime_artifact_unavailable", "model_routing")).toBe("model_routing");
});

test("filesystem ENOSPC names host disk exhaustion without exposing exception text", () => {
  const error = Object.assign(new Error("private_diagnostic"), { code: "ENOSPC" });
  expect(runtimeStartupFailure(error, "artifact_preparation")).toBe("disk_full");
  for (const code of ["EACCES", "EPERM"])
    expect(runtimeStartupFailure(Object.assign(new Error("private"), { code }), "artifact_preparation")).toBe(
      "artifact_permission",
    );
});
