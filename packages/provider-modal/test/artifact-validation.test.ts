import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunnerArtifact } from "../src/artifact.ts";

const pinned = {
  protocol: 1,
  bun: "1.4.2",
  claudeSdk: "0.3.322",
  claude: "2.1.322",
  codex: "0.167.0",
  architecture: "x64",
};
const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("disk loader validates bytes, pins, architecture and native resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-disk-"));
  try {
    await Bun.write(join(root, "manifest.json"), JSON.stringify(pinned));
    await Bun.write(join(root, "main.js"), "");
    await expect(loadRunnerArtifact(root)).rejects.toThrow("empty");
    await Bun.write(join(root, "main.js"), "abc");
    for (const field of ["protocol", "bun", "claudeSdk", "claude", "codex"]) {
      await Bun.write(join(root, "manifest.json"), JSON.stringify({ ...pinned, [field]: "wrong" }));
      await expect(loadRunnerArtifact(root)).rejects.toThrow("pinned");
    }
    await Bun.write(join(root, "manifest.json"), JSON.stringify({ ...pinned, architecture: "unsupported" }));
    await expect(loadRunnerArtifact(root)).rejects.toThrow("pinned");
    await Bun.write(join(root, "manifest.json"), JSON.stringify(pinned));
    for (const path of ["claude", "codex", "codex-runtime/bin/codex"]) {
      await expect(loadRunnerArtifact(root)).rejects.toThrow("native resources missing");
      await Bun.write(join(root, path), "fixture");
    }
    expect((await loadRunnerArtifact(root)).sha256).toBe(digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded portable loader rejects empty/unpinned artifacts without requiring native files or host architecture", async () => {
  // Copy the real loader into a disposable package tree so file imports resolve fixture assets,
  // never mutating the workspace artifact used by concurrent tests.
  const root = await mkdtemp(join(tmpdir(), "armada-embedded-"));
  try {
    const src = join(root, "packages/provider-modal/src");
    for (const file of ["embedded.ts", "artifact-validation.ts", "errors.ts", "ports.ts"])
      await Bun.write(join(src, file), Bun.file(join(import.meta.dir, "../src", file)));
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
    const dist = join(root, "packages/agent-runtime/dist");
    await Bun.write(
      join(root, "check.ts"),
      `import { loadEmbeddedRunnerArtifact } from "./packages/provider-modal/src/embedded.ts";
console.log(JSON.stringify(await loadEmbeddedRunnerArtifact()));`,
    );
    async function run(bundle: string, manifest: unknown) {
      await Bun.write(join(dist, "main.js"), bundle);
      await Bun.write(join(dist, "manifest.json"), JSON.stringify(manifest));
      const child = Bun.spawn([process.execPath, join(root, "check.ts")], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }
    const portable = { ...pinned, architecture: "not-the-host", artifact: "portable-bundle" };
    const empty = await run("", portable);
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("empty");
    const mismatch = await run("abc", { ...portable, codex: "wrong" });
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain("pinned");
    const valid = await run("abc", portable);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout).sha256).toBe(digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
