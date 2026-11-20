import runnerPath from "../../agent-runtime/dist/main.js" with { type: "file" };
import manifestFile from "../../agent-runtime/dist/manifest.json" with { type: "file" };
import { validateRunnerArtifact } from "./artifact-validation.ts";
export async function loadEmbeddedRunnerArtifact(): Promise<{ bundle: Uint8Array; sha256: string }> {
  const manifest = await Bun.file(String(manifestFile)).json();
  const bundle = new Uint8Array(await Bun.file(runnerPath).arrayBuffer());
  return validateRunnerArtifact(manifest, bundle);
}
