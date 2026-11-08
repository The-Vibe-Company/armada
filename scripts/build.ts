/**
 * Compiles the `armada` binary with `bun build --compile`.
 *
 *   bun scripts/build.ts                     this machine's target, to dist/armada
 *   bun scripts/build.ts --target linux-x64  one target, to dist/armada-linux-x64
 *   bun scripts/build.ts --all               every target, to dist/armada-<target>
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
export type Target = (typeof TARGETS)[number];

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/cli/src/main.ts");

export function hostTarget(): Target {
  const target = `${process.platform}-${process.arch}`;
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(`No armada binary for ${target}.`);
  return target as Target;
}

/** Compiles one target to `outfile` and returns its path. */
export function compile(target: Target, outfile: string): string {
  const result = Bun.spawnSync(
    [process.execPath, "build", ENTRY, "--compile", "--minify", `--target=bun-${target}`, `--outfile=${outfile}`],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) throw new Error(`bun build --compile failed for ${target}.`);
  return outfile;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string" }, all: { type: "boolean", default: false } },
  });
  const dist = join(ROOT, "dist");
  if (values.all) {
    for (const target of TARGETS) compile(target, join(dist, `armada-${target}`));
  } else if (values.target) {
    if (!(TARGETS as readonly string[]).includes(values.target)) {
      throw new Error(`Unknown target ${values.target}; expected one of ${TARGETS.join(", ")}.`);
    }
    compile(values.target as Target, join(dist, `armada-${values.target}`));
  } else {
    compile(hostTarget(), join(dist, "armada"));
  }
}
