import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishManifest } from "./publish-runtime-artifacts.ts";

test("publication includes every requested digest and refuses missing or corrupt pinned bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-"));
  try {
    const pin = async (path: string) => {
      const bytes = Buffer.from(path);
      await Bun.write(join(root, path), bytes);
      return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const manifest = {
      architecture: "arm64",
      runtime: await pin("runtime"),
      harnesses: { codex: { archive: await pin("codex.tar.gz") } },
      opencode: await pin("opencode"),
    };
    const destination = join(root, "published");
    await publishManifest(manifest, root, destination);
    const pins = [manifest.runtime, manifest.harnesses.codex.archive, manifest.opencode];
    expect((await readdir(destination)).sort()).toEqual(pins.map((p) => p.sha256).sort());
    for (const p of pins) {
      expect(await Bun.file(join(destination, p.sha256)).text()).toBe(p.path);
      expect((await stat(join(destination, p.sha256))).mode & 0o222).toBe(0);
    }
    await Bun.write(join(root, "opencode"), "bad");
    await expect(publishManifest(manifest, root, join(root, "rejected"))).rejects.toThrow("does not match manifest");
    await rm(join(root, "opencode"));
    await expect(publishManifest(manifest, root, join(root, "rejected"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
