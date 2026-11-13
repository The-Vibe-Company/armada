import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntimeTool } from "../src/tool-cache.ts";

// The real downloader/cache, archive reader and foreground executable own integrity and self-test decisions.
async function fixture(badVersion = false) {
  const home = await mkdtemp(join(tmpdir(), "runtime-tool-"));
  const files = {
    skillpack: `#!/bin/sh\n[ -z "\${SKILLPACK_API_KEY-}\${OPENAI_API_KEY-}\${ANTHROPIC_API_KEY-}\${GH_TOKEN-}" ] || exit 91\nprintf '%s\\n' ${badVersion ? "wrong" : "'skillpack 0.3.5'"}\n`,
    "skillpack-runtime": "#!/bin/sh\nprintf '%s\\n' 'skillpack-runtime 0.3.5'\n",
  };
  const archive = await new Bun.Archive({
    ...files,
    LICENSE: "public release license",
    NOTICE: "public release notice",
    "SOURCE.json": "{}",
  }).bytes();
  const artifact = { sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.byteLength };
  const input = {
    home,
    cacheDir: join(home, "cache"),
    signal: new AbortController().signal,
    tool: {
      url: "https://github.com/fixture/tool.tar.gz",
      archive: artifact,
      executable: "skillpack",
      versions: { skillpack: "skillpack 0.3.5", "skillpack-runtime": "skillpack-runtime 0.3.5" },
    },
  };
  return {
    home,
    input,
    archive,
    artifact,
    async close() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("pinned runtime tool download prepares verified foreground binaries with clean env and repairs a corrupt warm cache", async () => {
  const f = await fixture();
  let requests = 0;
  const fetcher = async (url: URL, options: RequestInit) => {
    requests++;
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("manual");
    expect(options.headers).toBeUndefined();
    return url.host === "github.com"
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.example/tool" } })
      : new Response(f.archive);
  };
  const original = { key: process.env.SKILLPACK_API_KEY, model: process.env.OPENAI_API_KEY };
  process.env.SKILLPACK_API_KEY = "must-not-reach-preparation";
  process.env.OPENAI_API_KEY = "must-not-reach-preparation";
  try {
    const prepared = await installRuntimeTool(f.input, fetcher);
    expect(await readFile(prepared.executable, "utf8")).toContain("skillpack 0.3.5");
    await prepared.dispose();
    const warm = await installRuntimeTool(f.input, () => {
      throw Error("verified cache must not download");
    });
    await warm.dispose();
    await writeFile(join(f.input.cacheDir, "archives", f.artifact.sha256), new Uint8Array(f.artifact.bytes));
    const repaired = await installRuntimeTool(f.input, fetcher);
    expect(requests).toBe(4);
    await repaired.dispose();
  } finally {
    if (original.key === undefined) delete process.env.SKILLPACK_API_KEY;
    else process.env.SKILLPACK_API_KEY = original.key;
    if (original.model === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original.model;
    await f.close();
  }
});

test("runtime tool preparation refuses unsafe redirects, changed bytes and failed version self-tests", async () => {
  const f = await fixture(),
    invalid = await fixture(true);
  try {
    await expect(
      installRuntimeTool(
        f.input,
        async () => new Response(null, { status: 302, headers: { location: "http://unsafe.example/tool" } }),
      ),
    ).rejects.toThrow("invalid_runtime_tool_redirect");
    await expect(
      installRuntimeTool(f.input, async () => new Response(new Uint8Array(f.artifact.bytes))),
    ).rejects.toThrow("runtime_artifact_digest_mismatch");
    await expect(installRuntimeTool(invalid.input, async () => new Response(invalid.archive))).rejects.toThrow(
      "runtime_tool_self_test_failed",
    );
  } finally {
    await f.close();
    await invalid.close();
  }
});
