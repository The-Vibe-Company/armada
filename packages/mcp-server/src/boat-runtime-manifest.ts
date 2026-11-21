import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runtimeArtifactPin } from "./runtime-artifacts.ts";
import { ServerConfigError } from "./server-config-error.ts";

/** Installed server image metadata, never a client-controlled path. Native
 * rollback must boot even when runtime-only artifacts are missing/corrupt. */
export async function readBoatRuntimeManifest(
  path: string,
  mode: "native" | "runtime",
  artifactDirectory: string | undefined,
) {
  try {
    const row = await Bun.file(path).json();
    const runtime = runtimeArtifactPin(row?.runtime);
    if (
      row?.protocol !== 1 ||
      row.platform !== "linux" ||
      row.libc !== "glibc" ||
      !["x64", "arm64"].includes(row.architecture) ||
      !runtime
    )
      throw Error();
    if (mode === "runtime") {
      if (!artifactDirectory?.trim() || !row.harnesses?.claude || !row.harnesses?.codex) throw Error();
      const archives = Object.values<{ archive?: unknown; files?: unknown }>(row.harnesses).map((harness) => {
        const archive = runtimeArtifactPin(harness?.archive);
        if (!archive || !Array.isArray(harness.files) || !harness.files.length) throw Error();
        return archive;
      });
      const opencode = runtimeArtifactPin(row.opencode);
      if (!opencode) throw Error();
      await Promise.all(
        [runtime, ...archives, opencode].map(async ({ sha256, bytes }) => {
          const file = await lstat(join(artifactDirectory, sha256));
          if (!file.isFile() || file.size !== bytes) throw Error();
        }),
      );
    }
    return { manifest: row as unknown, architecture: row.architecture as "x64" | "arm64" };
  } catch {
    if (mode === "runtime")
      throw new ServerConfigError(
        "ARMADA_BOAT_AGENT_PATH=runtime requires valid installed runtime artifacts. Check ARMADA_BOAT_RUNTIME_MANIFEST and ARMADA_RUNTIME_ARTIFACT_DIR.",
      );
    return undefined;
  }
}
