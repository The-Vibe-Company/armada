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
 * The host's shared artifact directory, `<state>/artifact-cache` under the canonical state path
 * (world-readable: it holds only public, digest-named bytes). `ensure` (re)creates it before each
 * container create/start; it never throws. Undefined only when the path cannot be a Docker
 * `--mount` value, in which case the host simply runs without a shared cache.
 */
export async function sharedArtifactDirectory(
  stateDirectory: string,
): Promise<{ dir: string; ensure(): Promise<boolean> } | undefined> {
  const dir = join(await realpath(stateDirectory), "artifact-cache");
  // A Docker --mount field value: refuse separators rather than quote them.
  if (/[,"=\0\n\r]/.test(dir)) return undefined;
  const ensure = async () => {
    try {
      await mkdir(dir, { recursive: true, mode: 0o755 });
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      await chmod(dir, 0o755);
      return true;
    } catch {
      return false;
    }
  };
  await ensure();
  return { dir, ensure };
}

/**
 * Host-level verified harness cache (#2562). After a bootstrap, fetch the public artifact set deployed
 * with that runtime digest, verify every artifact through the shared installer (fixed HTTPS origin,
 * no credentials or redirects, exact size and SHA256) into a private cache, then publish read-only
 * digest-named copies for sandboxes. Sandboxes re-verify size and digest, so this is an optimization
 * only: every failure leaves them on today's HTTP path. Runs are serialized. The small set is
 * re-read on every bootstrap (a redeploy may change archives without changing the runtime), and
 * each change prunes entries named by neither the current nor the previous set, so alternating
 * deployments do not re-download each other's artifacts.
 */
export function sharedArtifactWarmer(
  options: { serverUrl: string; privateDir: string; sharedDir: string },
  request: typeof fetch = fetch,
) {
  const origin = new URL(options.serverUrl).origin;
  let queue: Promise<void> = Promise.resolve();
  let current: Set<string> = new Set();
  let previous: Set<string> = new Set();

  async function warm(runtime: string) {
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
    const named = new Set(artifacts.map((artifact) => artifact.sha256));
    const changed = named.size !== current.size || [...named].some((sha) => !current.has(sha));
    for (const artifact of artifacts) {
      const target = join(options.sharedDir, artifact.sha256);
      const published = await lstat(target).catch(() => undefined);
      if (!changed && published?.isFile() && published.size === artifact.bytes && (published.mode & 0o777) === 0o444)
        continue;
      const verified = await installRuntimeArtifact(
        { serverUrl: origin, cacheDir: options.privateDir, artifact },
        request,
      );
      // Republish from the verified private copy when the set changes or the entry is missing,
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
    if (!changed) return;
    if (current.size) previous = current;
    current = named;
    for (const directory of [options.sharedDir, options.privateDir])
      for (const name of await readdir(directory).catch(() => [] as string[]))
        if (!current.has(name) && !previous.has(name))
          await rm(join(directory, name), { recursive: true, force: true });
  }

  /** Never throws and never delays the caller; the returned promise settles when this run ends. */
  return (runtime: string): Promise<void> => {
    if (!digest.test(runtime)) return queue;
    queue = queue.then(() => warm(runtime)).catch(() => {});
    return queue;
  };
}
