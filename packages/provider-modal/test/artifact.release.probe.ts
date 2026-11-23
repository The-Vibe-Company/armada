import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = join(import.meta.dir, "../../agent-runtime/dist");
const manifest = Bun.file(join(dist, "manifest.json"));
const nativeBuild = (await manifest.exists()) && (await manifest.json()).artifact !== "portable-bundle";
if (process.platform !== "linux" || !nativeBuild)
  throw new Error("Release conformance requires the Linux native runtime build");
async function verifyArtifact(root: string) {
  const deadline = AbortSignal.timeout(15_000);
  for (const [name, version] of [
    ["claude", "2.1.322"],
    ["codex", "0.167.0"],
    ["opencode", "1.19.5"],
  ]) {
    const native = Bun.spawn([join(dist, name ?? ""), "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      signal: deadline,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
    });
    const [exit, output] = await Promise.all([native.exited, new Response(native.stdout).text()]);
    expect(exit).toBe(0);
    expect(output).toContain(version ?? "");
  }
}

const root = await mkdtemp(join(tmpdir(), "armada-artifact-"));
try {
  await verifyArtifact(root);
} finally {
  await rm(root, { recursive: true, force: true });
}
