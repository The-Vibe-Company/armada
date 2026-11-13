import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { OPENCODE_ARTIFACT } from "./src/opencode-artifact.ts";

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw Error("Build runner artifact on target Linux architecture");
const root = import.meta.dir;
const out = join(root, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Build separate graphs: a multi-entry build retains main-runtime-only Core
// dependencies in the small SSH broker, which has a strict transport budget.
for (const entry of ["main.ts", "github-boat-main.ts"]) {
  const result = await Bun.build({
    entrypoints: [join(root, "src", entry)],
    target: "bun",
    outdir: out,
  });
  if (!result.success) throw Error("Runner bundle failed");
}
const require = createRequire(join(root, "package.json"));
const codexRequire = createRequire(require.resolve("@openai/codex/package.json"));
const vendor = dirname(codexRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`));
const triple = process.arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
await cp(join(vendor, "vendor", triple), join(out, "codex-runtime"), { recursive: true });
await rm(join(out, "codex"), { force: true });
await symlink("codex-runtime/bin/codex", join(out, "codex"));
const claudeRequire = createRequire(require.resolve("@anthropic-ai/claude-code/package.json"));
await copyFile(
  join(dirname(claudeRequire.resolve(`@anthropic-ai/claude-code-linux-${process.arch}/package.json`)), "claude"),
  join(out, "claude"),
);
await chmod(join(out, "codex"), 0o755);
await chmod(join(out, "claude"), 0o755);
const opencodeRequire = createRequire(require.resolve("opencode-ai/package.json"));
const opencode = join(dirname(opencodeRequire.resolve(`opencode-linux-${process.arch}/package.json`)), "bin/opencode");
const opencodeDigest = createHash("sha256")
  .update(await Bun.file(opencode).bytes())
  .digest("hex");
if (opencodeDigest !== OPENCODE_ARTIFACT.sha256[process.arch as "x64" | "arm64"])
  throw Error("OpenCode artifact digest mismatch");
await copyFile(opencode, join(out, "opencode"));
await chmod(join(out, "opencode"), 0o755);
await Bun.write(
  join(out, "manifest.json"),
  JSON.stringify({
    protocol: 1,
    bun: "1.4.2",
    claudeSdk: "0.3.322",
    claude: "2.1.322",
    codex: "0.167.0",
    opencode: { version: OPENCODE_ARTIFACT.version, sha256: opencodeDigest },
    architecture: process.arch,
  }),
);
