import { dirname, join } from "node:path";
import { SKILLPACK_RUNTIME } from "../../core/src/skillpack-runtime.ts";
import { installRuntimeTool } from "./tool-cache.ts";

/** Preserve image/golden CLI support; a plain runtime lazily prepares the same verified public pin. */
export async function prepareRuntimeSkillpack(
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<{ path: string; dispose(): Promise<void> }> {
  const home = environment.HOME ?? "/home/user";
  const path = `${environment.PATH ?? "/usr/bin:/bin"}:${join(home, ".local/bin")}`;
  if (Bun.which("skillpack", { PATH: path })) return { path, async dispose() {} };
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw Error("skillpack_cli_unavailable");
  const artifact = SKILLPACK_RUNTIME.archives[process.arch];
  try {
    const installed = await installRuntimeTool(
      {
        home,
        cacheDir: join(home, ".local/share/armada/runtime-skillpack"),
        signal,
        tool: {
          url: `https://github.com/The-Vibe-Company/skillpack/releases/download/runtime-v${SKILLPACK_RUNTIME.version}/skillpack-runtime_${SKILLPACK_RUNTIME.version}_${artifact.target}.tar.gz`,
          archive: artifact,
          executable: "skillpack",
          versions: {
            skillpack: `skillpack ${SKILLPACK_RUNTIME.version}`,
            "skillpack-runtime": `skillpack-runtime ${SKILLPACK_RUNTIME.version}`,
          },
        },
      },
      fetcher,
    );
    return { path: `${dirname(installed.executable)}:${path}`, dispose: installed.dispose };
  } catch {
    throw Error(signal.aborted ? "skillpack_timeout" : "skillpack_download_unavailable");
  }
}
