import { createHash } from "node:crypto";
import { join } from "node:path";
import { ANTIGRAVITY_ARTIFACT } from "./antigravity-artifact.ts";
import type { RuntimeArtifact } from "./artifact-cache.ts";

export async function stageAntigravityArchive(directory: string, architecture: "x64" | "arm64") {
  const { url, archive } = ANTIGRAVITY_ARTIFACT[architecture];
  const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200) throw Error(`Antigravity artifact download failed: ${response.status}`);
  const bytes = await response.bytes();
  verifyAntigravityArchive(bytes, archive);
  const path = `antigravity-linux-${architecture}.tar.gz`;
  await Bun.write(join(directory, path), bytes);
  return { path, version: ANTIGRAVITY_ARTIFACT.version, ...archive };
}

export function verifyAntigravityArchive(bytes: Uint8Array, archive: RuntimeArtifact) {
  if (bytes.byteLength !== archive.bytes) throw Error("Antigravity artifact length mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256)
    throw Error("Antigravity artifact digest mismatch");
}
