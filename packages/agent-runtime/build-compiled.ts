/** Opt-in Boat artifact. The existing Modal bundle/build is deliberately unchanged. */
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { version } from "./package.json";
import { harnessInventory } from "./src/harness-cache.ts";

const { values } = parseArgs({ options: { arch: { type: "string" }, out: { type: "string" } } });
const architecture = values.arch ?? process.arch;
if (Bun.version !== "1.4.2" || process.platform !== "linux" || !["x64", "arm64"].includes(architecture))
  throw Error("Compiled runtime build requires pinned Bun 1.4.2 on Linux for x64 or arm64");
const root = import.meta.dir;
const out = values.out ?? join(root, "dist/compiled");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const executable = join(out, "armada-runtime");
const build = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-dotenv",
    `--target=bun-linux-${architecture}`,
    join(root, "src/main.ts"),
    "--outfile",
    executable,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (await build.exited) throw Error("Compiled runtime build failed");
const require = createRequire(join(root, "package.json"));
const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
const vendor = dirname(codexRequire.resolve(`@openai/codex-linux-${architecture}/package.json`));
const triple = architecture === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
async function packHarness(source: string, archive: string) {
  const pack = Bun.spawn(
    [
      "tar",
      "--format=gnu",
      "--sort=name",
      "--mtime=@0",
      "--mode=a=rX,u+w",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--hard-dereference",
      "-I",
      "gzip -n",
      "-cf",
      join(out, archive),
      "-C",
      source,
      ".",
    ],
    { stdout: "inherit", stderr: "inherit", env: { ...process.env, LC_ALL: "C" } },
  );
  if (await pack.exited) throw Error(`Harness archive failed: ${archive}`);
}
const codexRoot = join(vendor, "vendor", triple);
await packHarness(codexRoot, "codex.tar.gz");
const claudeRequire = createRequire(require.resolve("@anthropic-ai/claude-code/package.json"));
const claudeRoot = join(out, "claude-runtime");
await mkdir(claudeRoot);
await copyFile(
  join(dirname(claudeRequire.resolve(`@anthropic-ai/claude-code-linux-${architecture}/package.json`)), "claude"),
  join(claudeRoot, "claude"),
);
await chmod(join(claudeRoot, "claude"), 0o755);
await packHarness(claudeRoot, "claude.tar.gz");
await chmod(executable, 0o755);
async function file(name: string) {
  const bytes = await Bun.file(join(out, name)).arrayBuffer();
  return {
    path: name,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
  };
}
await Bun.write(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      protocol: 1,
      version,
      platform: "linux",
      architecture,
      libc: "glibc",
      bun: Bun.version,
      runtime: await file("armada-runtime"),
      harnesses: {
        claude: {
          version: "2.1.322",
          archive: await file("claude.tar.gz"),
          executable: "claude",
          files: await harnessInventory(claudeRoot),
        },
        codex: {
          version: "0.167.0",
          archive: await file("codex.tar.gz"),
          executable: "bin/codex",
          files: await harnessInventory(codexRoot),
        },
      },
    },
    null,
    2,
  ),
);
