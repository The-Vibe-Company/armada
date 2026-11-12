/** Opt-in Boat artifact. The existing Modal bundle/build is deliberately unchanged. */
import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { version } from "./package.json";

if (Bun.version !== "1.4.2" || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw Error("Compiled runtime build requires pinned Bun 1.4.2 on target Linux architecture");
const root = import.meta.dir;
const out = join(root, "dist/compiled");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const executable = join(out, "armada-runtime");
const build = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    `--target=bun-linux-${process.arch}`,
    join(root, "src/main.ts"),
    "--outfile",
    executable,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (await build.exited) throw Error("Compiled runtime build failed");
const require = createRequire(join(root, "package.json"));
const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
const vendor = dirname(codexRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`));
const triple = process.arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
const pack = Bun.spawn(["tar", "-czf", join(out, "codex.tar.gz"), "-C", join(vendor, "vendor", triple), "."], {
  stdout: "inherit",
  stderr: "inherit",
});
if (await pack.exited) throw Error("Codex archive failed");
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
      architecture: process.arch,
      libc: "glibc",
      bun: Bun.version,
      runtime: await file("armada-runtime"),
      harnesses: { codex: { version: "0.167.0", archive: await file("codex.tar.gz"), executable: "bin/codex" } },
    },
    null,
    2,
  ),
);
