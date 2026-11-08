/**
 * Stages the npm packages of the `armada` CLI from compiled binaries (scripts/build.ts).
 *
 *   bun scripts/npm.ts --binaries dist                      every target, to dist/npm
 *   bun scripts/npm.ts --binaries dist --target linux-x64   one platform package (smoke tests)
 *
 * `@thevibecompany/armada` holds the `armada` bin, a Node launcher (packages/cli/npm/armada.cjs),
 * and lists one optional dependency per target. `@thevibecompany/armada-<target>` holds that
 * target's binary, restricted by `os` and `cpu`, so npm and Bun install only the one that runs.
 * Platform packages are returned first: they are published before the package that needs them.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TARGETS, type Target } from "./build.ts";

export const NPM_PACKAGE = "@thevibecompany/armada";

const ROOT = join(import.meta.dir, "..");
const VERSION: string = (await Bun.file(join(ROOT, "packages/core/package.json")).json()).version;
const LAUNCHER = join(ROOT, "packages/cli/npm/armada.cjs");
const LICENSE = join(ROOT, "LICENSE");

const COMMON = {
  license: "MIT",
  homepage: "https://github.com/The-Vibe-Company/armada#readme",
  bugs: "https://github.com/The-Vibe-Company/armada/issues",
  repository: {
    type: "git",
    url: "git+https://github.com/The-Vibe-Company/armada.git",
    directory: "packages/cli",
  },
  publishConfig: { access: "public" },
};

export function platformPackage(target: Target): string {
  return `${NPM_PACKAGE}-${target}`;
}

export interface StagedPackage {
  name: string;
  dir: string;
}

export interface StageOptions {
  /** A directory holding `armada-<target>` binaries. */
  binaries: string;
  out: string;
  targets?: readonly Target[];
  version?: string;
}

export function stageNpm(options: StageOptions): StagedPackage[] {
  const version = options.version ?? VERSION;
  const targets = options.targets ?? TARGETS;
  rmSync(options.out, { recursive: true, force: true });
  const staged: StagedPackage[] = [];

  for (const target of targets) {
    const binary = join(options.binaries, `armada-${target}`);
    if (!existsSync(binary)) throw new Error(`Missing ${binary}: build it with bun run build --target ${target}.`);
    const [os, cpu] = target.split("-");
    const name = platformPackage(target);
    const dir = join(options.out, `armada-${target}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(binary, join(dir, "bin/armada"));
    chmodSync(join(dir, "bin/armada"), 0o755);
    copyFileSync(LICENSE, join(dir, "LICENSE"));
    writeJson(join(dir, "package.json"), {
      name,
      version,
      description: `The armada binary for ${target}. Install ${NPM_PACKAGE}, not this package.`,
      ...COMMON,
      os: [os],
      cpu: [cpu],
      files: ["bin/armada"],
    });
    writeFileSync(
      join(dir, "README.md"),
      `# ${name}\n\nThe \`armada\` binary for ${target}, used by [\`${NPM_PACKAGE}\`](https://www.npmjs.com/package/${NPM_PACKAGE}).\n`,
    );
    staged.push({ name, dir });
  }

  const dir = join(options.out, "armada");
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(LAUNCHER, join(dir, "bin/armada.cjs"));
  chmodSync(join(dir, "bin/armada.cjs"), 0o755);
  copyFileSync(LICENSE, join(dir, "LICENSE"));
  copyFileSync(join(ROOT, "packages/cli/npm/README.md"), join(dir, "README.md"));
  writeJson(join(dir, "package.json"), {
    name: NPM_PACKAGE,
    version,
    description: "Launch coding agents (Claude Code, Codex) on boat.dev sandboxes: the armada command line.",
    keywords: ["armada", "agents", "coding-agents", "claude-code", "codex", "mcp", "cli"],
    ...COMMON,
    bin: { armada: "bin/armada.cjs" },
    files: ["bin/armada.cjs"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(TARGETS.map((target) => [platformPackage(target), version])),
  });
  staged.push({ name: NPM_PACKAGE, dir });
  return staged;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      binaries: { type: "string", default: join(ROOT, "dist") },
      out: { type: "string", default: join(ROOT, "dist/npm") },
      target: { type: "string", multiple: true },
    },
  });
  for (const target of values.target ?? []) {
    if (!(TARGETS as readonly string[]).includes(target)) {
      throw new Error(`Unknown target ${target}; expected one of ${TARGETS.join(", ")}.`);
    }
  }
  const staged = stageNpm({
    binaries: values.binaries,
    out: values.out,
    ...(values.target ? { targets: values.target as Target[] } : {}),
  });
  for (const { name, dir } of staged) console.log(`${name}\t${dir}`);
}
