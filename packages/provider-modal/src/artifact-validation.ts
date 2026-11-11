import { createHash } from "node:crypto";
import { refusal } from "./errors.ts";

/** Shared portable artifact contract; native resources belong to the disk adapter. */
export function validateRunnerArtifact(manifest: unknown, bundle: Uint8Array): { bundle: Uint8Array; sha256: string } {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("protocol" in manifest) ||
    manifest.protocol !== 1 ||
    !("bun" in manifest) ||
    manifest.bun !== "1.4.2" ||
    !("claudeSdk" in manifest) ||
    manifest.claudeSdk !== "0.3.322" ||
    !("claude" in manifest) ||
    manifest.claude !== "2.1.322" ||
    !("codex" in manifest) ||
    manifest.codex !== "0.167.0"
  )
    throw refusal("invalid_request", "Runtime artifact manifest does not match pinned toolchain.");
  if (!bundle.length) throw refusal("invalid_request", "Runtime artifact is empty.");
  return { bundle, sha256: createHash("sha256").update(bundle).digest("hex") };
}
