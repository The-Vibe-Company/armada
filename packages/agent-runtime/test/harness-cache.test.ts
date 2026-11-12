import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSelectedHarness } from "../src/harness-cache.ts";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const files = {
  "bin/codex": "#!/bin/sh\necho fixture-codex\n",
  "codex-path/rg": "#!/bin/sh\nexit 0\n",
  "resources/info.json": '{"fixture":true}',
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-cache-"));
  const archive = await new Bun.Archive(files, { compress: "gzip" }).bytes();
  const codex = {
    version: "0.167.0",
    executable: "bin/codex",
    archive: { sha256: sha(archive), bytes: archive.byteLength },
    files: Object.entries(files).map(([path, value]) => ({
      path,
      bytes: Buffer.byteLength(value),
      sha256: sha(Buffer.from(value)),
      executable: path !== "resources/info.json",
    })),
  };
  const manifest = {
    protocol: 1,
    platform: "linux",
    architecture: process.arch,
    libc: "glibc",
    harnesses: { codex, claude: { archive: { sha256: "f".repeat(64), bytes: 1 } } },
  };
  const requests: string[] = [];
  const input = { serverUrl: "https://armada.example", cacheDir: join(root, "cache"), harness: "codex", manifest };
  const fetcher = async (url: URL, options: RequestInit) => {
    requests.push(url.href);
    expect(options.redirect).toBe("error");
    expect(options.credentials).toBe("omit");
    expect(options.headers).toBeUndefined();
    return new Response(archive);
  };
  return { root, input, manifest, codex, archive, requests, fetcher };
}

test("selected pinned harness installs private verified files, reuses image cache offline and repairs corrupt resources", async () => {
  const f = await fixture();
  try {
    const first = await installSelectedHarness(f.input, f.fetcher);
    expect(await readFile(first.executable, "utf8")).toBe(files["bin/codex"]);
    expect((await lstat(first.executable)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(first.root, "resources/info.json"))).mode & 0o777).toBe(0o600);
    expect(f.requests).toEqual([`https://armada.example/api/runtime/artifacts/${f.codex.archive.sha256}`]);
    await rm(join(f.input.cacheDir, "archives"), { recursive: true });
    expect(
      await installSelectedHarness(f.input, async () => {
        throw Error("network must not be used by verified image cache");
      }),
    ).toEqual(first);
    await writeFile(join(first.root, "resources/info.json"), "corrupt");
    expect(await installSelectedHarness(f.input, f.fetcher)).toEqual(first);
    expect(await readFile(join(first.root, "resources/info.json"), "utf8")).toBe(files["resources/info.json"]);
    expect(f.requests).toHaveLength(2);
    await chmod(first.executable, 0o600);
    expect(
      await installSelectedHarness(f.input, async () => {
        throw Error("archive cache already exists");
      }),
    ).toEqual(first);
    expect((await lstat(first.executable)).mode & 0o777).toBe(0o700);
    expect((await readdir(f.input.cacheDir)).some((name) => name.startsWith(".codex-install-"))).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid selected manifest/path/architecture is refused before fetching, and wrong contents never publish a harness", async () => {
  const f = await fixture();
  try {
    await expect(installSelectedHarness({ ...f.input, harness: "claude" }, f.fetcher)).rejects.toThrow(
      "unsupported_harness_artifact",
    );
    await expect(
      installSelectedHarness({ ...f.input, manifest: { ...f.manifest, architecture: "wrong" } }, f.fetcher),
    ).rejects.toThrow("incompatible_harness_manifest");
    for (const path of ["../escape", "/absolute", "C:/escape", "a\\escape", "a//b", "."]) {
      const manifest = {
        ...f.manifest,
        harnesses: { codex: { ...f.codex, files: [...f.codex.files, { ...f.codex.files[0], path }] } },
      };
      await expect(installSelectedHarness({ ...f.input, manifest }, f.fetcher)).rejects.toThrow("invalid_harness_path");
    }
    expect(f.requests).toHaveLength(0);
    const manifest = {
      ...f.manifest,
      harnesses: { codex: { ...f.codex, files: f.codex.files.map((file) => ({ ...file, sha256: "0".repeat(64) })) } },
    };
    await expect(installSelectedHarness({ ...f.input, manifest }, f.fetcher)).rejects.toThrow(
      "harness_archive_mismatch",
    );
    expect(await readdir(f.input.cacheDir)).toEqual(["archives"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("only regular archive entries become files: symlinks neither appear in cache nor affect outside paths", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "source");
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, "bin/codex"), files["bin/codex"]);
    await symlink("bin/codex", join(source, "alias"));
    const outside = join(f.root, "outside");
    await writeFile(outside, "canary");
    await symlink(outside, join(source, "outside-link"));
    const tar = join(f.root, "links.tar.gz");
    const pack = Bun.spawn(["tar", "-czf", tar, "-C", source, "."], { stdout: "ignore", stderr: "ignore" });
    expect(await pack.exited).toBe(0);
    const bytes = await Bun.file(tar).bytes();
    const manifest = {
      ...f.manifest,
      harnesses: {
        codex: {
          ...f.codex,
          archive: { sha256: sha(bytes), bytes: bytes.byteLength },
          files: f.codex.files.filter((file) => file.path === "bin/codex"),
        },
      },
    };
    const installed = await installSelectedHarness({ ...f.input, manifest }, async () => new Response(bytes));
    expect(await readdir(installed.root)).toEqual(["bin"]);
    expect(await readFile(outside, "utf8")).toBe("canary");
    expect(await readFile(installed.executable, "utf8")).toBe(files["bin/codex"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("truncated native archive reads cannot pass a complete per-file inventory", async () => {
  const f = await fixture();
  try {
    const data = "payload".repeat(2000),
      complete = await new Bun.Archive({ "bin/codex": data }).bytes(),
      truncated = complete.slice(0, 1024);
    const manifest = {
      ...f.manifest,
      harnesses: {
        codex: {
          ...f.codex,
          archive: { sha256: sha(truncated), bytes: truncated.byteLength },
          files: [
            { path: "bin/codex", sha256: sha(Buffer.from(data)), bytes: Buffer.byteLength(data), executable: true },
          ],
        },
      },
    };
    await expect(
      installSelectedHarness({ ...f.input, manifest }, async () => new Response(truncated)),
    ).rejects.toThrow();
    expect(await readdir(f.input.cacheDir)).toEqual(["archives"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
