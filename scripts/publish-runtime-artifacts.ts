/** Docker publication: copy only manifest-selected public executable bytes. */
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { OPENCODE_ARTIFACT } from "../packages/agent-runtime/src/opencode-artifact.ts";

type FilePin = { path: string; sha256: string; bytes: number };
export type PublicationManifest = {
  architecture: string;
  runtime: FilePin;
  harnesses: Record<string, { archive: FilePin }>;
  opencode: FilePin;
};

export async function publishManifest(manifest: PublicationManifest, source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  const pins = [manifest.runtime, ...Object.values(manifest.harnesses).map((h) => h.archive), manifest.opencode];
  for (const pin of pins) {
    if (
      !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes < 1 ||
      !/^[a-zA-Z0-9_.-]+$/.test(pin.path)
    )
      throw Error("Invalid publication pin");
    const bytes = await Bun.file(join(source, pin.path)).bytes();
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      throw Error(`Artifact does not match manifest: ${pin.path}`);
    const target = join(destination, pin.sha256);
    await copyFile(join(source, pin.path), target);
    await chmod(target, 0o444);
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const destination = process.argv[2] ?? join(root, "dist/runtime-artifacts");
  const manifests = join(root, "dist/runtime-manifests");
  await mkdir(manifests, { recursive: true });
  const require = createRequire(join(root, "packages/agent-runtime/package.json"));
  const opencodeRequire = createRequire(require.resolve("opencode-ai/package.json"));
  for (const architecture of ["x64", "arm64"] as const) {
    const source = join(root, "dist/runtime-build", architecture);
    const build = Bun.spawnSync(
      [
        process.execPath,
        join(root, "packages/agent-runtime/build-compiled.ts"),
        "--arch",
        architecture,
        "--out",
        source,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (build.exitCode !== 0) throw Error(`Runtime build failed: ${architecture}`);
    const manifest = await Bun.file(join(source, "manifest.json")).json();
    const binary = join(
      dirname(opencodeRequire.resolve(`opencode-linux-${architecture}/package.json`)),
      "bin/opencode",
    );
    await copyFile(binary, join(source, "opencode"));
    manifest.opencode = {
      path: "opencode",
      version: OPENCODE_ARTIFACT.version,
      bytes: OPENCODE_ARTIFACT.bytes[architecture],
      sha256: OPENCODE_ARTIFACT.sha256[architecture],
    };
    await publishManifest(manifest, source, destination);
    await Bun.write(join(manifests, `${architecture}.json`), JSON.stringify(manifest, null, 2));
  }
  await chmod(destination, 0o555);
}
