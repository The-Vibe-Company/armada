import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Trusted start/resume metadata, not model input. No credentials belong in artifact requests. */
export interface RuntimeArtifact {
  sha256: string;
  bytes: number;
}
const MAX_BYTES = 512 * 1024 * 1024;

/** Content-addressed cache; never changes the running executable or follows a mutable version alias. */
export async function installRuntimeArtifact(
  input: { serverUrl: string; cacheDir: string; artifact: RuntimeArtifact },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  const { artifact, cacheDir } = input;
  const server = new URL(input.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.pathname !== "/" ||
    !isAbsolute(cacheDir) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes > MAX_BYTES
  )
    throw Error("invalid_runtime_artifact");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(cacheDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
    throw Error("runtime_cache_not_private");
  const target = join(cacheDir, artifact.sha256);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error("invalid_runtime_cache_entry");
  if (existing?.size === artifact.bytes) {
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(target).stream()) hash.update(chunk);
    if (hash.digest("hex") === artifact.sha256) {
      await chmod(target, 0o700);
      return target;
    }
  }
  const temporary = join(cacheDir, `.${artifact.sha256}.${crypto.randomUUID()}`);
  try {
    const response = await fetcher(new URL(`/api/runtime/artifacts/${artifact.sha256}`, server), {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(120000),
    });
    if (response.status !== 200 || !response.body) throw Error("runtime_artifact_unavailable");
    const file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > artifact.bytes) throw Error("runtime_artifact_size_mismatch");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
        throw Error("runtime_artifact_digest_mismatch");
      await file.chmod(0o700);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Also usable by a pre-filled compiled binary on hosts without a shell. */
export async function runArtifactInstallMode(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as Parameters<typeof installRuntimeArtifact>[0];
  const path = await installRuntimeArtifact(input);
  process.stdout.write(`${JSON.stringify({ path })}\n`);
}
