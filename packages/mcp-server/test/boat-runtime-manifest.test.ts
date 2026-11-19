import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoatRuntimeManifest } from "../src/boat-runtime-manifest.ts";

test("runtime default requires installed metadata, while native rollback survives missing/corrupt runtime artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "boat-mode-")),
    path = join(root, "manifest.json");
  try {
    for (const contents of [undefined, "{not-json", JSON.stringify({ protocol: 0 })]) {
      if (contents !== undefined) await writeFile(path, contents);
      expect(await readBoatRuntimeManifest(path, "native")).toBeUndefined();
      await expect(readBoatRuntimeManifest(path, "runtime")).rejects.toThrow("no native fallback");
    }
    const manifest = {
      protocol: 1,
      platform: "linux",
      libc: "glibc",
      architecture: "x64",
      runtime: { sha256: "a".repeat(64), bytes: 10 },
      harnesses: { codex: { receipt: "preserved" } },
    };
    await writeFile(path, JSON.stringify(manifest));
    for (const mode of ["native", "runtime"] as const)
      expect(await readBoatRuntimeManifest(path, mode)).toEqual({ manifest, architecture: "x64" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
