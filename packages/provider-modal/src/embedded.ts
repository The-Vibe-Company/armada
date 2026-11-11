// Server-binary build entry. Build #510's pinned runtime artifact first. Bun embeds this asset in
// compiled binaries; no workspace modules, external runner file or native binaries are read remotely.
import { validateRunnerArtifact } from "./artifact-validation.ts";
import runnerPath from "../../agent-runtime/dist/main.js" with { type: "file" };
import manifestFile from "../../agent-runtime/dist/manifest.json" with { type: "file" };
export async function loadEmbeddedRunnerArtifact(): Promise<{ bundle: Uint8Array; sha256: string }> {
  const manifest = await Bun.file(String(manifestFile)).json();
  const bundle = new Uint8Array(await Bun.file(runnerPath).arrayBuffer());
  return validateRunnerArtifact(manifest, bundle);
}
