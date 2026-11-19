import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoatRuntimeManifest } from "../src/boat-runtime-manifest.ts";

test("runtime default requires installed metadata and artifacts, while native rollback survives missing/corrupt runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "boat-mode-")),
    path = join(root, "manifest.json");
  try {
    for (const contents of [undefined, "{not-json", JSON.stringify({ protocol: 0 })]) {
      if (contents !== undefined) await writeFile(path, contents);
      expect(await readBoatRuntimeManifest(path, "native", root)).toBeUndefined();
      await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow("no native fallback");
    }
    const manifest = {
      protocol: 1,
      platform: "linux",
      libc: "glibc",
      architecture: "x64",
      runtime: { sha256: "a".repeat(64), bytes: 10 },
      harnesses: {
        codex: { archive: { sha256: "b".repeat(64), bytes: 5 } },
        claude: { archive: { sha256: "c".repeat(64), bytes: 5 } },
      },
      opencode: { sha256: "d".repeat(64), bytes: 6 },
    };
    await writeFile(path, JSON.stringify(manifest));
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow("ARMADA_RUNTIME_ARTIFACT_DIR");
    await writeFile(join(root, manifest.runtime.sha256), new Uint8Array(manifest.runtime.bytes));
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow("ARMADA_RUNTIME_ARTIFACT_DIR");
    for (const artifact of [manifest.harnesses.codex.archive, manifest.harnesses.claude.archive, manifest.opencode])
      await writeFile(join(root, artifact.sha256), new Uint8Array(artifact.bytes));
    const { opencode, ...incomplete } = manifest;
    await writeFile(path, JSON.stringify(incomplete));
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow("ARMADA_RUNTIME_ARTIFACT_DIR");
    await writeFile(path, JSON.stringify({ ...incomplete, opencode }));
    for (const mode of ["native", "runtime"] as const)
      expect(await readBoatRuntimeManifest(path, mode, root)).toEqual({ manifest, architecture: "x64" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
