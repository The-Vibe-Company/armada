import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { installRuntimeArtifact, type RuntimeArtifact } from "./artifact-cache.ts";
import { ChildOwner } from "./children.ts";

type PinnedTool = {
  url: string;
  archive: RuntimeArtifact;
  versions: Record<string, string>;
  executable: string;
};
/** Trusted pinned-tool preparation. No request fields, inherited credentials, unsafe extraction or system links. */
export async function installRuntimeTool(
  input: { home: string; cacheDir: string; tool: PinnedTool; signal: AbortSignal },
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<{ executable: string; dispose(): Promise<void> }> {
  const { tool, signal } = input;
  const url = new URL(tool.url);
  const names = Object.keys(tool.versions);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isAbsolute(input.home) ||
    !isAbsolute(input.cacheDir) ||
    !names.length ||
    names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)) ||
    !names.includes(tool.executable)
  )
    throw Error("invalid_runtime_tool");
  signal.throwIfAborted();
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  const cache = await lstat(input.cacheDir);
  if (!cache.isDirectory() || cache.isSymbolicLink() || cache.mode & 0o077) throw Error("invalid_runtime_tool_cache");
  const archive = await installRuntimeArtifact(
    { serverUrl: url.origin, cacheDir: join(input.cacheDir, "archives"), artifact: tool.archive },
    async (_address, options) => {
      let address = url;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await fetcher(address, {
          ...options,
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.any([signal, options.signal ?? AbortSignal.timeout(120000)]),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw Error("invalid_runtime_tool_redirect");
          address = new URL(location, address);
          if (address.protocol !== "https:" || address.username || address.password)
            throw Error("invalid_runtime_tool_redirect");
          continue;
        }
        if (response.url && new URL(response.url).protocol !== "https:") throw Error("invalid_runtime_tool_redirect");
        return response;
      }
      throw Error("invalid_runtime_tool_redirect");
    },
  );
  const root = await mkdtemp(join(input.cacheDir, ".prepared-"));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const contents = await new Bun.Archive(await Bun.file(archive).bytes()).files();
    if (contents.size > 64 || names.some((name) => !contents.has(name))) throw Error("invalid_runtime_tool_archive");
    for (const [name, blob] of contents) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw Error("invalid_runtime_tool_archive");
      if (!names.includes(name)) continue;
      const file = await open(join(root, name), "wx", 0o700);
      try {
        for await (const chunk of blob.stream()) await file.writeFile(chunk);
      } finally {
        await file.close();
      }
    }
    const owner = new ChildOwner();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const abort = () => {
      void owner.close().catch(() => {});
    };
    bounded.addEventListener("abort", abort, { once: true });
    try {
      const run = async (name: string, args: string[], capture = true) => {
        bounded.throwIfAborted();
        const child = owner.spawn(join(root, name), args, {
          env: { HOME: input.home, PATH: `${root}:/usr/bin:/bin`, SKILLPACK_TELEMETRY: "0" },
        });
        child.stdin.end();
        let output = "",
          excessive = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (!capture) return;
          if (output.length + chunk.length > 4096) {
            excessive = true;
            abort();
          } else output += chunk.toString();
        });
        child.stderr.resume();
        const code = await new Promise<number | null>((resolve) => {
          child.once("close", resolve);
          child.once("error", () => resolve(null));
        });
        await owner.release(child);
        if (code !== 0 || excessive || bounded.aborted) throw Error("runtime_tool_self_test_failed");
        return output.trim();
      };
      for (const name of names)
        if ((await run(name, ["--version"])) !== tool.versions[name]) throw Error("runtime_tool_self_test_failed");
      await run(tool.executable, ["--help"], false);
    } finally {
      bounded.removeEventListener("abort", abort);
      await owner.close();
    }
    return { executable: join(root, tool.executable), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
