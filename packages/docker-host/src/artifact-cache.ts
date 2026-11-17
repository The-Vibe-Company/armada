import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { installRuntimeArtifact, type RuntimeArtifact } from "../../agent-runtime/src/artifact-cache.ts";

const MAX_SET_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 16;
const digest = /^[a-f0-9]{64}$/;

function pin(value: unknown): RuntimeArtifact {
  const v = value as { sha256?: unknown; bytes?: unknown } | null;
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).sort().join() !== "bytes,sha256" ||
    typeof v.sha256 !== "string" ||
    !digest.test(v.sha256) ||
    !Number.isSafeInteger(v.bytes) ||
    (v.bytes as number) < 1 ||
    (v.bytes as number) > 512 * 1024 * 1024
  )
    throw Error("invalid_artifact_set");
  return { sha256: v.sha256, bytes: v.bytes as number };
}

/**
 * Create the host's shared artifact directory (world-readable: it holds only public, digest-named
 * bytes) and return its canonical path for the read-only container bind mount. A host that cannot
 * prepare it keeps launching without a shared cache rather than failing every container create.
 */
export async function prepareSharedArtifactDir(directory: string): Promise<string | undefined> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    await chmod(directory, 0o755);
    const canonical = await realpath(directory);
    // The path is a Docker --mount field value: refuse separators rather than quote them.
    return /[,"=\0\n\r]/.test(canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}

/**
 * Host-level verified harness cache (#2562). After a bootstrap, fetch the public artifact set deployed
 * with that runtime digest, verify every artifact through the shared installer (fixed HTTPS origin,
 * no credentials or redirects, exact size and SHA256) into a private cache, then publish read-only
 * digest-named copies for sandboxes. Sandboxes re-verify size and digest, so this is an optimization
 * only: every failure leaves them on today's HTTP path. Runs are serialized; each prunes entries the
 * current set no longer names, so the cache holds one deployment's artifacts.
 */
export function sharedArtifactWarmer(
  options: { serverUrl: string; privateDir: string; sharedDir: string },
  request: typeof fetch = fetch,
) {
  const origin = new URL(options.serverUrl).origin;
  let queue: Promise<void> = Promise.resolve();
  let warmed: string | undefined;

  async function warm(runtime: string) {
    if (warmed === runtime) return;
    const response = await request(new URL(`/api/runtime/artifact-sets/${runtime}`, origin), {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    // An older server has no artifact-set route: nothing to warm.
    if (response.status !== 200) return;
    const text = await response.text();
    if (text.length > MAX_SET_BYTES) throw Error("invalid_artifact_set");
    const set = JSON.parse(text) as { runtime?: unknown; artifacts?: unknown };
    if (
      !set ||
      typeof set !== "object" ||
      Object.keys(set).sort().join() !== "artifacts,runtime" ||
      pin(set.runtime).sha256 !== runtime ||
      !Array.isArray(set.artifacts) ||
      set.artifacts.length > MAX_ARTIFACTS
    )
      throw Error("invalid_artifact_set");
    const artifacts = set.artifacts.map(pin);
    const keep = new Set(artifacts.map((artifact) => artifact.sha256));
    for (const artifact of artifacts) {
      const verified = await installRuntimeArtifact(
        { serverUrl: origin, cacheDir: options.privateDir, artifact },
        request,
      );
      const target = join(options.sharedDir, artifact.sha256);
      // Republish from the verified private copy once per run (repairing a damaged shared file),
      // atomically: a reader never sees a partial file and an already open copy stays readable.
      const temporary = join(options.sharedDir, `.${artifact.sha256}.${crypto.randomUUID()}`);
      try {
        await copyFile(verified, temporary);
        await chmod(temporary, 0o444);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    for (const directory of [options.sharedDir, options.privateDir])
      for (const name of await readdir(directory).catch(() => [] as string[]))
        if (!keep.has(name)) await rm(join(directory, name), { recursive: true, force: true });
    warmed = runtime;
  }

  /** Never throws and never delays the caller; the returned promise settles when this run ends. */
  return (runtime: string): Promise<void> => {
    if (!digest.test(runtime)) return queue;
    queue = queue.then(() => warm(runtime)).catch(() => {});
    return queue;
  };
}
