import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { installSelectedHarness } from "./harness-cache.ts";

/** Private server-issued configuration, never accepted from a runner command. */
export async function prepareEnrolledHarness(
  serverUrl: string,
  configuration: {
    root: string;
    selectedHarness?: unknown;
    artifactManifest?: unknown;
    codexEnv: Record<string, string>;
  },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
) {
  if (
    configuration.selectedHarness !== "codex" ||
    typeof configuration.root !== "string" ||
    !isAbsolute(configuration.root) ||
    configuration.root === "/" ||
    !configuration.codexEnv ||
    typeof configuration.codexEnv !== "object" ||
    Array.isArray(configuration.codexEnv) ||
    Object.values(configuration.codexEnv).some((value) => typeof value !== "string")
  )
    throw Error("invalid_enrolled_harness");
  await mkdir(configuration.root, { recursive: true, mode: 0o700 });
  const root = await lstat(configuration.root);
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077) throw Error("enrolled_root_not_private");
  const installed = await installSelectedHarness(
    {
      serverUrl,
      cacheDir: join(configuration.root, "artifacts", "harnesses"),
      harness: configuration.selectedHarness,
      manifest: configuration.artifactManifest,
    },
    fetcher,
  );
  const codexEnv: Record<string, string> = {
    ...configuration.codexEnv,
    PATH: [...installed.pathEntries, configuration.codexEnv.PATH ?? "/usr/bin:/bin"].join(":"),
  };
  return { codexExecutable: installed.executable, codexEnv };
}
