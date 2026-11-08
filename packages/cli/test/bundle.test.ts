import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the compiled CLI bundle contains no provider or database-client runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-cli-bundle-"));
  try {
    const outfile = join(directory, "main.js");
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/main.ts")],
      outdir: directory,
      target: "bun",
      minify: true,
    });
    expect(result.success).toBe(true);
    const bundle = await readFile(outfile, "utf8");
    expect(bundle).not.toMatch(/supabase/i);
    expect(bundle).not.toMatch(/postgrest/i);
    expect(bundle).not.toMatch(/\.well-known\/armada/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
