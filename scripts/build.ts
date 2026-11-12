/**
 * Compiles the `armada` binary with `bun build --compile`.
 *
 *   bun scripts/build.ts                     this machine's target, to dist/armada
 *   bun scripts/build.ts --target linux-x64  one target, to dist/armada-linux-x64
 *   bun scripts/build.ts --all               every target, to dist/armada-<target>
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
export type Target = (typeof TARGETS)[number];

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/cli/src/main.ts");
const SERVER_ENTRY = join(ROOT, "packages/mcp-server/src/main.ts");

export function hostTarget(): Target {
  const target = `${process.platform}-${process.arch}`;
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(`No armada binary for ${target}.`);
  return target as Target;
}

/** Compiles one target to `outfile` and returns its path. */
export function compile(target: Target, outfile: string, entry = ENTRY): string {
  const requiredMigration = readdirSync(join(ROOT, "supabase/migrations"))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort()
    .at(-1)
    ?.slice(0, 14);
  if (!requiredMigration) throw new Error("Cannot compile without a required migration version.");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      entry,
      "--compile",
      "--minify",
      "--define",
      `ARMADA_REQUIRED_MIGRATION=${JSON.stringify(requiredMigration)}`,
      `--target=bun-${target}`,
      `--outfile=${outfile}`,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) throw new Error(`bun build --compile failed for ${target}.`);
  return outfile;
}

export function compileServer(target: Target, outfile: string): string {
  const prepared = Bun.spawnSync([process.execPath, join(ROOT, "scripts/prepare-runtime.ts")], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (prepared.exitCode !== 0) throw new Error("Pinned runtime preparation failed.");
  return compile(target, outfile, SERVER_ENTRY);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string" }, all: { type: "boolean", default: false } },
  });
  const dist = join(ROOT, "dist");
  if (values.all) {
    for (const target of TARGETS) {
      compile(target, join(dist, `armada-${target}`));
      compileServer(target, join(dist, `armada-server-${target}`));
    }
  } else if (values.target) {
    if (!(TARGETS as readonly string[]).includes(values.target)) {
      throw new Error(`Unknown target ${values.target}; expected one of ${TARGETS.join(", ")}.`);
    }
    const target = values.target as Target;
    compile(target, join(dist, `armada-${target}`));
    compileServer(target, join(dist, `armada-server-${target}`));
  } else {
    const target = hostTarget();
    compile(target, join(dist, "armada"));
    compileServer(target, join(dist, "armada-server"));
  }
}
