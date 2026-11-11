import { validateRunnerArtifact } from "./artifact-validation.ts";
import { join } from "node:path";
import { refusal } from "./errors.ts";
/** Build with packages/agent-runtime/build.ts under Bun1.4.2 on target Linux first.
 * Native resources are installed in image from identical pinned official packages,
 * retaining complete vendor trees (Codex resources/path helpers and Claude executable).
 */
export async function loadRunnerArtifact(dist: string): Promise<{ bundle: Uint8Array; sha256: string }> {
  const manifest = await Bun.file(join(dist, "manifest.json")).json();
  const bundle = new Uint8Array(await Bun.file(join(dist, "main.js")).arrayBuffer());
  const artifact = validateRunnerArtifact(manifest, bundle);
  if (!["x64", "arm64"].includes(manifest.architecture))
    throw refusal("invalid_request", "Runtime artifact manifest does not match pinned toolchain.");
  for (const path of ["claude", "codex", "codex-runtime/bin/codex"])
    if (!(await Bun.file(join(dist, path)).exists()))
      throw refusal("invalid_request", "Runtime native resources missing.");
  return artifact;
}
