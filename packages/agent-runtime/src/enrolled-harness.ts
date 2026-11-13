import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { installSelectedHarness } from "./harness-cache.ts";
import { prepareOpenCode } from "./opencode-install.ts";

/** Private server-issued configuration, never accepted from a runner command. */
export async function prepareEnrolledHarness(
  serverUrl: string,
  configuration: {
    root: string;
    selectedHarness?: unknown;
    artifactManifest?: unknown;
    claudeEnv: Record<string, string>;
    codexEnv: Record<string, string>;
    opencodeEnv?: Record<string, string>;
  },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
) {
  const env =
    configuration.selectedHarness === "claude"
      ? configuration.claudeEnv
      : configuration.selectedHarness === "opencode"
        ? configuration.opencodeEnv
        : configuration.codexEnv;
  if (
    !["codex", "claude", "opencode"].includes(configuration.selectedHarness as string) ||
    typeof configuration.root !== "string" ||
    !isAbsolute(configuration.root) ||
    configuration.root === "/" ||
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.values(env).some((value) => typeof value !== "string")
  )
    throw Error("invalid_enrolled_harness");
  await mkdir(configuration.root, { recursive: true, mode: 0o700 });
  const root = await lstat(configuration.root);
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077) throw Error("enrolled_root_not_private");
  if (configuration.selectedHarness === "opencode") {
    const executable = await prepareOpenCode({
      candidate: join(configuration.root, "artifacts", "opencode"),
      serverUrl,
      cacheDir: join(configuration.root, "artifacts", "opencode-cache"),
    });
    return {
      opencodeExecutable: executable,
      opencodeEnv: { ...env },
      codexExecutable: "",
      claudeExecutable: "",
      codexEnv: configuration.codexEnv,
      claudeEnv: configuration.claudeEnv,
    };
  }
  const installed = await installSelectedHarness(
    {
      serverUrl,
      cacheDir: join(configuration.root, "artifacts", "harnesses"),
      harness: configuration.selectedHarness as string,
      manifest: configuration.artifactManifest,
    },
    fetcher,
  );
  const selectedEnv: Record<string, string> = {
    ...env,
    PATH: [...installed.pathEntries, env.PATH ?? "/usr/bin:/bin"].join(":"),
  };
  return {
    codexExecutable: configuration.selectedHarness === "codex" ? installed.executable : "",
    claudeExecutable: configuration.selectedHarness === "claude" ? installed.executable : "",
    codexEnv: configuration.selectedHarness === "codex" ? selectedEnv : configuration.codexEnv,
    claudeEnv: configuration.selectedHarness === "claude" ? selectedEnv : configuration.claudeEnv,
  };
}
