import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoatRuntimeManifest } from "../src/boat-runtime-manifest.ts";

test("runtime default requires installed artifacts, while native rollback survives missing/corrupt runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "boat-mode-")),
    path = join(root, "manifest.json");
  try {
    for (const contents of [undefined, "{not-json", JSON.stringify({ protocol: 0 })]) {
      if (contents !== undefined) await writeFile(path, contents);
      expect(await readBoatRuntimeManifest(path, "native", root)).toBeUndefined();
      await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow(
        "requires valid installed runtime artifacts",
      );
    }
    const manifest = {
      protocol: 1,
      platform: "linux",
      libc: "glibc",
      architecture: "x64",
      runtime: { sha256: "a".repeat(64), bytes: 10 },
      harnesses: {
        codex: { archive: { sha256: "b".repeat(64), bytes: 5 }, files: [{}] },
        claude: { archive: { sha256: "c".repeat(64), bytes: 5 }, files: [{}] },
      },
      opencode: { sha256: "d".repeat(64), bytes: 5 },
    };
    await writeFile(path, JSON.stringify(manifest));
    const expected = { manifest, architecture: "x64" };
    expect(await readBoatRuntimeManifest(path, "native", undefined)).toEqual(expected);
    await expect(readBoatRuntimeManifest(path, "runtime", undefined)).rejects.toThrow("ARMADA_RUNTIME_ARTIFACT_DIR");
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow(
      "requires valid installed runtime artifacts",
    );
    await writeFile(join(root, manifest.runtime.sha256), "0123456789");
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow(
      "requires valid installed runtime artifacts",
    );
    await writeFile(join(root, manifest.harnesses.codex.archive.sha256), "12");
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow(
      "requires valid installed runtime artifacts",
    );
    await writeFile(join(root, manifest.harnesses.codex.archive.sha256), "12345");
    await writeFile(join(root, manifest.harnesses.claude.archive.sha256), "12345");
    await writeFile(join(root, manifest.opencode.sha256), "12345");
    expect(await readBoatRuntimeManifest(path, "runtime", root)).toEqual(expected);
    await writeFile(path, JSON.stringify({ ...manifest, opencode: undefined }));
    await expect(readBoatRuntimeManifest(path, "runtime", root)).rejects.toThrow(
      "requires valid installed runtime artifacts",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
