import { createExec } from "../../src/spawn.ts";

/**
 * Bundles entrypoints for Node in a fresh `bun build` process.
 * In-process `Bun.build` shares bundler state with the test runner and with
 * earlier builds in the same `bun test` run; Bun 1.3.x then misreads source
 * files in a later build, so a test's result depends on which files ran first.
 */
export async function bundleForNode(entrypoints: string[], outdir: string, options: { external?: string[] } = {}) {
  const args = ["build", ...entrypoints, "--target=node", "--outdir", outdir, "--entry-naming", "[name].[ext]"];
  for (const name of options.external ?? []) args.push("--external", name);
  const result = await createExec()(process.execPath, args, {
    cwd: outdir,
    timeoutMs: 60_000,
    env: { PATH: process.env.PATH },
  });
  if (result.code !== 0) throw new Error(`bun build failed (${result.code}): ${result.stderr}`);
}
