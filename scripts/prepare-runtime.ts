/** Portable bundle preparation. Linux-native extraction/version validation stays in #510's build.ts. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

if (Bun.version !== "1.4.2") throw new Error("Prepare the runtime with pinned Bun 1.4.2.");
const root = join(import.meta.dir, "../packages/agent-runtime");
await mkdir(join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts"), join(root, "src/github-boat-main.ts")],
  target: "bun",
  outdir: join(root, "dist"),
});
if (!result.success) throw new AggregateError(result.logs, "Runtime bundle failed.");
await Bun.write(
  join(root, "dist/manifest.json"),
  JSON.stringify({
    protocol: 1,
    bun: Bun.version,
    claudeSdk: "0.3.322",
    claude: "2.1.322",
    codex: "0.167.0",
    artifact: "portable-bundle",
    architecture: process.arch,
  }),
);
