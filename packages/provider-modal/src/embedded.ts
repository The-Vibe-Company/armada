// Server-binary build entry. Build #510's pinned runtime artifact first. Bun embeds this asset in
// compiled binaries; no workspace modules, external runner file or native binaries are read remotely.
import { createHash } from "node:crypto";
import runnerPath from "../../agent-runtime/dist/main.js" with { type: "file" };
import manifestFile from "../../agent-runtime/dist/manifest.json" with { type: "file" };
import { refusal } from "./errors.ts";
export async function loadEmbeddedRunnerArtifact(): Promise<{ bundle: Uint8Array; sha256: string }> {
  const manifest = await Bun.file(String(manifestFile)).json();
  if (
    manifest.protocol !== 1 ||
    manifest.bun !== "1.4.2" ||
    manifest.claudeSdk !== "0.3.319" ||
    manifest.claude !== "2.1.319" ||
    manifest.codex !== "0.167.0"
  )
    throw refusal("invalid_request", "Embedded runner manifest is not pinned.");
  const bundle = new Uint8Array(await Bun.file(runnerPath).arrayBuffer());
  return { bundle, sha256: createHash("sha256").update(bundle).digest("hex") };
}
