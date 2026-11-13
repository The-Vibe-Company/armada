import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { installRuntimeArtifact } from "./artifact-cache.ts";
import { OPENCODE_ARTIFACT } from "./opencode-artifact.ts";

/** Only selected OpenCode launches install a CLI, once at start/resume; never during a prompt. */
export async function prepareOpenCode(input: {
  candidate: string;
  serverUrl: string;
  cacheDir: string;
}): Promise<string> {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw Error("unsupported_opencode_artifact");
  const sha256 = OPENCODE_ARTIFACT.sha256[process.arch];
  const bytes = OPENCODE_ARTIFACT.bytes[process.arch];
  // A verified pre-filled native binary is a warm cache, not a different execution mode.
  const info = await lstat(input.candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    info?.isFile() &&
    !info.isSymbolicLink() &&
    info.size === bytes &&
    (info.mode & 0o111) !== 0 &&
    !(info.mode & 0o022)
  ) {
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(input.candidate).stream()) hash.update(chunk);
    if (hash.digest("hex") === sha256) return input.candidate;
  }
  return installRuntimeArtifact({ serverUrl: input.serverUrl, cacheDir: input.cacheDir, artifact: { sha256, bytes } });
}
