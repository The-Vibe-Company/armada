/**
 * Stages the npm packages of the `armada` CLI from compiled binaries (scripts/build.ts).
 *
 *   bun scripts/npm.ts --binaries dist                      every target, to dist/npm
 *   bun scripts/npm.ts --binaries dist --target linux-x64   one platform package (smoke tests)
 *
 * `@the-vibe-company/armada` holds the `armada` bin, a Node launcher (packages/cli/npm/armada.cjs),
 * and lists one optional dependency per target. `@the-vibe-company/armada-<target>` holds that
 * target's binary, restricted by `os` and `cpu`, so npm and Bun install only the one that runs.
 * Platform packages are returned first: they are published before the package that needs them.
 *
 * `stageSdk` stages `@the-vibe-company/armada-sdk` beside them (dist/npm/sdk): the workspace
 * `@armada/sdk` bundled with the browser-safe core values it uses, and a declaration file whose
 * core types are expanded, so the published package depends on no private workspace package.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TARGETS, type Target } from "./build.ts";

export const NPM_PACKAGE = "@the-vibe-company/armada";
export const SDK_PACKAGE = "@the-vibe-company/armada-sdk";

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
    description:
      "Launch Claude Code, Codex and OpenCode agents into Boat, Modal or Docker sandboxes: the armada command line.",
    keywords: ["armada", "agents", "coding-agents", "claude-code", "codex", "opencode", "mcp", "cli"],
    ...COMMON,
    bin: { armada: "bin/armada.cjs" },
    files: ["bin/armada.cjs"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(TARGETS.map((target) => [platformPackage(target), version])),
  });
  staged.push({ name: NPM_PACKAGE, dir });
  return staged;
}

/** Bundles the SDK into `<out>/sdk`, which must contain no reference to a workspace package. */
export async function stageSdk(options: { out: string; version?: string }): Promise<StagedPackage> {
  const version = options.version ?? VERSION;
  const entry = join(ROOT, "packages/sdk/src/index.ts");
  const dir = join(options.out, "sdk");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
  const [output] = built.outputs;
  if (!built.success || built.outputs.length !== 1 || !output) {
    throw new AggregateError(built.logs, "The SDK bundle failed.");
  }
  const code = await output.text();
  // A bare import resolves against the consumer's node_modules, where no workspace package exists.
  if (/^\s*import\b|\bfrom\s*["']|\bimport\(|\brequire\(/m.test(code)) {
    throw new Error("The SDK bundle must not import other modules.");
  }
  writeFileSync(join(dir, "index.js"), code);
  writeFileSync(join(dir, "index.d.ts"), await sdkDeclarations(entry));
  copyFileSync(LICENSE, join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "README.md"),
    `# ${SDK_PACKAGE}\n\nA small fetch-based TypeScript client for the Armada \`/api/v1\` API. See the [SDK guide](https://github.com/The-Vibe-Company/armada/blob/main/docs/sdk.md).\n`,
  );
  writeJson(join(dir, "package.json"), {
    name: SDK_PACKAGE,
    version,
    description: "TypeScript client for the Armada sandbox API: launch, send, wait, logs, stop, files and webhooks.",
    keywords: ["armada", "agents", "sandbox", "sdk"],
    ...COMMON,
    repository: { ...COMMON.repository, directory: "packages/sdk" },
    type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    types: "./index.d.ts",
    files: ["index.js", "index.d.ts"],
    sideEffects: false,
    engines: { node: ">=20.3" },
  });
  return { name: SDK_PACKAGE, dir };
}

/** Emits the SDK declarations, replacing each imported core type by the literal union it names. */
export async function sdkDeclarations(entry: string): Promise<string> {
  const ts = (await import("typescript")).default;
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    declaration: true,
    emitDeclarationOnly: true,
  });
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing ${entry}.`);
  let declarations = "";
  const emitted = program.emit(source, (_name, text) => {
    declarations = text;
  });
  if (emitted.emitSkipped || !declarations) throw new Error("The SDK declarations were not emitted.");
  const checker = program.getTypeChecker();
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const local = checker.getSymbolAtLocation(element.name);
      if (!local || !(local.flags & ts.SymbolFlags.Alias)) continue;
      const target = checker.getAliasedSymbol(local);
      if (!(target.flags & ts.SymbolFlags.TypeAlias)) continue;
      const text = checker.typeToString(
        checker.getDeclaredTypeOfSymbol(target),
        undefined,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
      );
      aliases.set(element.name.text, `type ${element.name.text} = ${text};\n`);
    }
  }
  const result = declarations.replace(/^import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];\n/gm, (_line, names: string) =>
    names
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim())
      .filter(Boolean)
      .map((name) => {
        const alias = aliases.get(name);
        if (!alias) throw new Error(`The SDK declarations import ${name}, which is not a type alias.`);
        return alias;
      })
      .join(""),
  );
  if (/^\s*import\b|\bfrom\s*["']|\bimport\(/m.test(result)) {
    throw new Error("The SDK declarations must not import other modules.");
  }
  return result;
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
  staged.push(await stageSdk({ out: values.out }));
  for (const { name, dir } of staged) console.log(`${name}\t${dir}`);
}
