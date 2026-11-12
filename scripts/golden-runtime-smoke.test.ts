import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../packages/core/helper/manifest.json";
import { helperProbe, skillpackProbe } from "./golden-runtime-smoke.ts";

test("helper probe accepts the pinned executable and rejects changed bytes without emitting guest output", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-probe-"));
  try {
    const platform = process.arch === "arm64" ? "aarch64" : "x86_64";
    const dir = join(root, ".local/share/armada/helper/0.1.0");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "armada-helper");
    writeFileSync(file, Buffer.from(manifest[platform].base64, "base64"));
    chmodSync(file, 0o755);
    mkdirSync(join(root, ".local/bin"), { recursive: true });
    symlinkSync(file, join(root, ".local/bin/armada-helper"));
    const command = helperProbe.replaceAll("/home/user", root);
    const run = () =>
      Bun.spawnSync(["bash", "-c", command], { env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" } });
    expect(run().exitCode).toBe(0);
    writeFileSync(file, "#!/bin/sh\necho untrusted-output\n");
    const rejected = run();
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout.toString() + rejected.stderr.toString()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Skillpack probe rejects an untrusted archive before extraction and removes temporary downloads", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-skillpack-probe-"));
  try {
    const bin = join(root, "bin");
    const downloads = join(root, "downloads");
    mkdirSync(bin);
    mkdirSync(downloads);
    // Only the transport is faked: the real sha256sum must reject these bytes.
    const curl = join(bin, "curl");
    writeFileSync(curl, '#!/bin/bash\nwhile [ "$1" != "-o" ]; do shift; done\nprintf invalid-archive > "$2"\n');
    chmodSync(curl, 0o755);
    const result = Bun.spawnSync(["bash", "-c", skillpackProbe], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: downloads },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toBe("");
    expect(Array.from(new Bun.Glob("*").scanSync(downloads))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
