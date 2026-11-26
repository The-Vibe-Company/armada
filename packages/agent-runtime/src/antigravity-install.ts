import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ANTIGRAVITY_ARTIFACT } from "./antigravity-artifact.ts";
import {
  type ArtifactFetcher,
  installRuntimeArtifactFromUrl,
  type RuntimeArtifact,
  readSharedArtifact,
} from "./artifact-cache.ts";

type AntigravityPin = { url: string; archive: RuntimeArtifact; executable: RuntimeArtifact };

function currentPin() {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw Error("unsupported_antigravity_artifact");
  return ANTIGRAVITY_ARTIFACT[process.arch];
}

async function verifiedExecutable(path: string, pin: RuntimeArtifact) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!file) return false;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== pin.bytes || !(info.mode & 0o111) || info.mode & 0o022)
      throw Error("antigravity_executable_mismatch");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > pin.bytes) throw Error("antigravity_executable_mismatch");
      hash.update(chunk);
    }
    if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256) throw Error("antigravity_executable_mismatch");
    return true;
  } finally {
    await file.close();
  }
}

export async function prepareAntigravity(
  input: {
    cacheDir: string;
    candidate?: string;
    sharedDir?: string;
    pin?: AntigravityPin;
  },
  fetcher: ArtifactFetcher = fetch,
) {
  const { cacheDir, candidate, sharedDir, pin = currentPin() } = input;
  if (candidate) {
    const path = resolve(candidate);
    if (await verifiedExecutable(path, pin.executable)) return path;
  }
  if (!isAbsolute(cacheDir) || !/^[a-f0-9]{64}$/.test(pin.executable.sha256)) throw Error("invalid_antigravity_cache");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const info = await lstat(cacheDir);
  if (!info.isDirectory() || info.mode & 0o077) throw Error("invalid_antigravity_cache");
  const target = join(cacheDir, `antigravity-${pin.executable.sha256}`);
  if (await verifiedExecutable(target, pin.executable)) return target;
  const archiveBytes =
    (sharedDir ? await readSharedArtifact(sharedDir, pin.archive) : undefined) ??
    (await Bun.file(
      await installRuntimeArtifactFromUrl(
        new URL(pin.url),
        { cacheDir: join(cacheDir, "archives"), artifact: pin.archive },
        fetcher,
      ),
    ).bytes());
  const executable = (await new Bun.Archive(archiveBytes).files()).get("antigravity");
  if (!executable || executable.size !== pin.executable.bytes) throw Error("antigravity_executable_mismatch");
  const temporary = join(cacheDir, `.antigravity-${crypto.randomUUID()}`);
  const file = await open(temporary, "wx", 0o700);
  try {
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of executable.stream()) {
        bytes += chunk.byteLength;
        if (bytes > pin.executable.bytes) throw Error("antigravity_executable_mismatch");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (bytes !== pin.executable.bytes || hash.digest("hex") !== pin.executable.sha256)
        throw Error("antigravity_executable_mismatch");
      await file.chmod(0o700);
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
