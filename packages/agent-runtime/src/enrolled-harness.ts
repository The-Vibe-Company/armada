import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isHarness } from "@armada/core";
import { parseAntigravityCredential } from "@armada/core/antigravity-credential";
import { SHARED_ARTIFACT_CACHE_PATH } from "../../core/src/shared-artifact-cache.ts";
import { prepareAntigravity } from "./antigravity-install.ts";
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
    antigravityCredential?: unknown;
  },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
  /** Docker hosts mount their verified digest-named cache here; elsewhere it is simply absent. */
  sharedDir: string = SHARED_ARTIFACT_CACHE_PATH,
) {
  const { root: rootPath, selectedHarness } = configuration;
  if (
    (selectedHarness !== "antigravity" && !isHarness(selectedHarness)) ||
    typeof rootPath !== "string" ||
    !isAbsolute(rootPath) ||
    rootPath === "/"
  )
    throw Error("invalid_enrolled_harness");
  const credential =
    selectedHarness === "antigravity" ? parseAntigravityCredential(configuration.antigravityCredential) : undefined;
  const env =
    selectedHarness === "claude"
      ? configuration.claudeEnv
      : selectedHarness === "opencode"
        ? configuration.opencodeEnv
        : configuration.codexEnv;
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.values(env).some((value) => typeof value !== "string")
  )
    throw Error("invalid_enrolled_harness");
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const root = await lstat(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077) throw Error("enrolled_root_not_private");
  if (credential) {
    const executable = await prepareAntigravity(
      { serverUrl, cacheDir: join(rootPath, "artifacts", "antigravity-cache"), sharedDir },
      fetcher,
    );
    return {
      antigravity: { executable, credential },
      codexExecutable: "",
      claudeExecutable: "",
      codexEnv: configuration.codexEnv,
      claudeEnv: configuration.claudeEnv,
    };
  }
  if (selectedHarness === "opencode") {
    const executable = await prepareOpenCode({
      candidate: join(configuration.root, "artifacts", "opencode"),
      serverUrl,
      cacheDir: join(configuration.root, "artifacts", "opencode-cache"),
      sharedDir,
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
      sharedDir,
      harness: selectedHarness,
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
