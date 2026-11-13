/** Portable bundle preparation. Linux-native extraction/version validation stays in #510's build.ts. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OPENCODE_ARTIFACT } from "../packages/agent-runtime/src/opencode-artifact.ts";

if (Bun.version !== "1.4.2") throw new Error("Prepare the runtime with pinned Bun 1.4.2.");
const root = join(import.meta.dir, "../packages/agent-runtime");
await mkdir(join(root, "dist"), { recursive: true });
// Build separate graphs: a multi-entry build retains main-runtime-only Core
// dependencies in the small SSH broker, which has a strict transport budget.
for (const entry of ["main.ts", "github-boat-main.ts"]) {
  const result = await Bun.build({
    entrypoints: [join(root, "src", entry)],
    target: "bun",
    outdir: join(root, "dist"),
  });
  if (!result.success) throw new AggregateError(result.logs, "Runtime bundle failed.");
}
await Bun.write(
  join(root, "dist/manifest.json"),
  JSON.stringify({
    protocol: 1,
    bun: Bun.version,
    claudeSdk: "0.3.322",
    claude: "2.1.322",
    codex: "0.167.0",
    opencode: {
      version: OPENCODE_ARTIFACT.version,
      sha256: OPENCODE_ARTIFACT.sha256[process.arch === "arm64" ? "arm64" : "x64"],
    },
    artifact: "portable-bundle",
    architecture: process.arch,
  }),
);
