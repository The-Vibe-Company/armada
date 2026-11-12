import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { installRuntimeArtifact, type RuntimeArtifact } from "./artifact-cache.ts";

interface HarnessFile extends RuntimeArtifact {
  path: string;
  executable: boolean;
}
interface Harness {
  version: string;
  archive: RuntimeArtifact;
  executable: string;
  files: HarnessFile[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    isAbsolute(value) ||
    /[\\:\0]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("invalid_harness_path");
  return value;
}
function artifact(value: unknown, empty = false): RuntimeArtifact {
  if (
    !record(value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < (empty ? 0 : 1) ||
    (value.bytes as number) > 512 * 1024 * 1024
  )
    throw Error("invalid_harness_artifact");
  return { sha256: value.sha256, bytes: value.bytes as number };
}
function selected(manifest: unknown, harness: string): Harness {
  if (harness !== "codex") throw Error("unsupported_harness_artifact");
  if (
    !record(manifest) ||
    manifest.protocol !== 1 ||
    manifest.platform !== "linux" ||
    manifest.libc !== "glibc" ||
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch) ||
    manifest.architecture !== process.arch ||
    !record(manifest.harnesses)
  )
    throw Error("incompatible_harness_manifest");
  const value = manifest.harnesses[harness];
  if (
    !record(value) ||
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(value.version) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 4096
  )
    throw Error("invalid_harness_manifest");
  const files = value.files.map((file: unknown) => {
    if (!record(file) || typeof file.executable !== "boolean") throw Error("invalid_harness_manifest");
    return { ...artifact(file, true), path: path(file.path), executable: file.executable };
  });
  const executable = path(value.executable);
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.reduce((sum, file) => sum + file.bytes, 0) > 2 * 1024 * 1024 * 1024 ||
    !files.some((file) => file.path === executable && file.executable)
  )
    throw Error("invalid_harness_manifest");
  return { version: value.version, archive: artifact(value.archive), executable, files };
}
async function digest(blob: Blob) {
  const hash = createHash("sha256");
  for await (const chunk of blob.stream()) hash.update(chunk);
  return hash.digest("hex");
}
/** Shared build inventory: regular files only; no directory links or setuid permissions are published. */
export async function harnessInventory(root: string): Promise<HarnessFile[]> {
  const files: HarnessFile[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name),
        info = await lstat(file);
      if (info.isSymbolicLink()) throw Error("harness_inventory_symlink");
      if (info.isDirectory()) await visit(file);
      else {
        if (!info.isFile()) throw Error("harness_inventory_not_regular");
        const name = path(relative(root, file).split(sep).join("/"));
        files.push({
          path: name,
          bytes: info.size,
          sha256: await digest(Bun.file(file)),
          executable: !!(info.mode & 0o111),
        });
      }
    }
  }
  await visit(root);
  return files;
}
async function verified(root: string, expected: readonly HarnessFile[]): Promise<boolean> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) return false;
    const actual = await harnessInventory(root);
    if (actual.length !== expected.length) return false;
    const wanted = new Map(expected.map((file) => [file.path, file]));
    for (const file of actual) {
      const spec = wanted.get(file.path);
      if (!spec || file.bytes !== spec.bytes || file.sha256 !== spec.sha256 || file.executable !== spec.executable)
        return false;
      if ((await lstat(join(root, file.path))).nlink !== 1) return false;
      if (((await lstat(join(root, file.path))).mode & 0o777) !== (spec.executable ? 0o700 : 0o600)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
/** Start/resume only. Returns paths; never executes, hot-swaps, or fetches unselected harnesses. */
export async function installSelectedHarness(
  input: { serverUrl: string; cacheDir: string; harness: string; manifest: unknown },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
) {
  const harness = selected(input.manifest, input.harness);
  const origin = new URL(input.serverUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("invalid_harness_origin");
  if (!isAbsolute(input.cacheDir)) throw Error("invalid_harness_cache");
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const cache = await lstat(input.cacheDir);
  if (!cache.isDirectory() || cache.isSymbolicLink() || (cache.mode & 0o777) !== 0o700)
    throw Error("invalid_harness_cache");
  const root = join(input.cacheDir, `codex-${harness.archive.sha256}`);
  const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw Error("invalid_harness_cache_entry");
  const receipt = () => ({
    root,
    executable: join(root, harness.executable),
    pathEntries: [join(root, "codex-path")],
    version: harness.version,
    sha256: harness.archive.sha256,
  });
  if (existing && (await verified(root, harness.files))) return receipt();
  const archive = await installRuntimeArtifact(
    { serverUrl: input.serverUrl, cacheDir: join(input.cacheDir, "archives"), artifact: harness.archive },
    fetcher,
  );
  const temporary = await mkdtemp(join(input.cacheDir, ".codex-install-"));
  try {
    // files() only returns regular files. Never call extract(): write verified blobs
    // ourselves into a new private directory, so archive symlinks cannot escape it.
    const contents = await new Bun.Archive(await Bun.file(archive).bytes()).files();
    const expected = new Map(harness.files.map((file) => [file.path, file]));
    const seen = new Set<string>();
    for (const [raw, blob] of contents) {
      const name = path(raw.replace(/^(\.\/)+/, "")),
        spec = expected.get(name);
      if (!spec || seen.has(name) || blob.size !== spec.bytes || (await digest(blob)) !== spec.sha256)
        throw Error("harness_archive_mismatch");
      seen.add(name);
      const target = join(temporary, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const file = await open(target, "wx", 0o600);
      try {
        for await (const chunk of blob.stream()) await file.writeFile(chunk);
        await file.chmod(spec.executable ? 0o700 : 0o600);
      } finally {
        await file.close();
      }
    }
    if (seen.size !== expected.size || !(await verified(temporary, harness.files)))
      throw Error("harness_archive_mismatch");
    // This directory is per sandbox and installation runs only while native work
    // is quiescent. Never remove a verified warm cache, even if another installer won.
    if (await verified(root, harness.files)) return receipt();
    await rm(root, { recursive: true, force: true });
    await rename(temporary, root);
    return receipt();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runHarnessInstallMode() {
  const input = JSON.parse(await Bun.stdin.text()) as Parameters<typeof installSelectedHarness>[0];
  process.stdout.write(`${JSON.stringify(await installSelectedHarness(input))}\n`);
}
