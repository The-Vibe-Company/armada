import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import ts from "typescript";
import core from "../../packages/core/package.json";
import boat from "../../packages/provider-boat/package.json";
import modal from "../../packages/provider-modal/package.json";

const coreSource = "packages/core/src/";
const providers: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([
  [boat.name, boat.exports],
  [modal.name, modal.exports],
]);
const sourceExtension = /\.[cm]?[jt]sx?$/;
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

const existingProviderImports = new Set([
  "packages/agent-runtime/test/github-parent.test.ts -> ../../provider-boat/src/native-cwd.ts",
  "packages/core/test/golden-os.probe.ts -> ../../provider-modal/src/ssh.ts",
  "packages/core/test/golden-snapshot-retirement.release.ts -> ../../provider-modal/src/store.ts",
  "packages/mcp-server/test/mcp-codex-bridge-fixture.ts -> ../../provider-boat/src/native-cwd.ts",
  "scripts/golden-os-image.ts -> ../packages/provider-modal/src/index.ts",
]);

function localTarget(file: string, specifier: string) {
  if (specifier.startsWith(".")) return join(dirname(file), specifier);
  if (file.startsWith("apps/dashboard/") && specifier.startsWith("@/")) {
    return join("apps/dashboard/src", specifier.slice(2));
  }
  return normalize(specifier);
}

function providerInternal(file: string, specifier: string, target: string) {
  for (const [name, entries] of providers) {
    const directory = `packages/${name.slice("@armada/".length)}/`;
    if (file.startsWith(directory)) continue;
    if (target.startsWith(`${directory}src/`)) return true;
    if (specifier.startsWith(`${name}/`) && !Object.hasOwn(entries, `.${specifier.slice(name.length)}`)) return true;
  }
  return false;
}

function resolveCoreModule(target: string, modules: ReadonlyMap<string, unknown>) {
  const stem = target.replace(sourceExtension, "");
  return [target, ...extensions.map((ext) => stem + ext), ...extensions.map((ext) => `${target}/index${ext}`)].find(
    (candidate) => modules.has(candidate),
  );
}

export function checkImportBoundaries(sources: ReadonlyMap<string, string>) {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const modules = new Map<string, { imports: Set<string>; runtimeImports: Set<string> }>();
  const errors: string[] = [];
  const report = (file: string, specifier: string, rule: string) => errors.push(`${file}: ${rule}: ${specifier}`);

  for (const [file, source] of sources) {
    const transpiler = /\.[jt]sx$/.test(file) ? transpilers.tsx : transpilers.ts;
    const runtimeImports = new Set(transpiler.scanImports(source.replace(/^#![^\n]*/, "")).map(({ path }) => path));
    const imports = new Set([
      ...runtimeImports,
      ...ts.preProcessFile(source, true, false).importedFiles.map(({ fileName }) => fileName),
    ]);
    const client = /^packages\/(cli|sdk)\/src\//.test(file);
    const dashboard = file.startsWith("apps/dashboard/src/");
    for (const specifier of imports) {
      const target = localTarget(file, specifier);
      const coreServer = /^(@armada\/core\/(src\/)?server|packages\/core\/src\/server)(?:\.|\/|$)/.test(target);
      const server = /^(packages\/mcp-server|@armada\/mcp-server)(?:\/|$)/.test(target);
      if (
        client &&
        (coreServer ||
          server ||
          /^(@supabase\/|@armada\/provider-|packages\/provider-|(?:@armada|packages)\/docker-host(?:\/|$))/.test(
            target,
          ))
      ) {
        report(file, specifier, "client-server-import");
      }
      if (
        dashboard &&
        (coreServer ||
          server ||
          /^(?:@armada\/core\/src|packages\/core\/src)\/vault-store(?:\.|$)/.test(target) ||
          /^(?:@armada\/auth\/src|packages\/auth\/src)\/sql(?:\.|$)/.test(target))
      ) {
        report(file, specifier, "dashboard-service-import");
      }
      if (providerInternal(file, specifier, target) && !existingProviderImports.has(`${file} -> ${specifier}`)) {
        report(file, specifier, "provider-private-import");
      }
    }
    if (file.startsWith(coreSource)) modules.set(file, { imports, runtimeImports });
  }

  const entries = new Map(Object.entries(core.exports).map(([key, value]) => [key, join("packages/core", value)]));
  const serverEntry = entries.get("./server");
  const pending = [...entries.values()].filter((file) => file !== serverEntry);
  const visited = new Set<string>();
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    const module = modules.get(file);
    if (!module) continue;
    for (const specifier of module.imports) {
      const key =
        specifier === core.name
          ? "."
          : specifier.startsWith(`${core.name}/`)
            ? `.${specifier.slice(core.name.length)}`
            : specifier;
      const target = entries.get(key) ?? localTarget(file, specifier.replace(/^@armada\/core\/src\//, coreSource));
      const resolved = resolveCoreModule(target, modules);
      if (specifier.startsWith("node:") || (resolved === serverEntry && resolved !== undefined)) {
        report(file, specifier, "browser-core-import");
      } else if (resolved && module.runtimeImports.has(specifier)) {
        pending.push(resolved);
      }
    }
  }
  return errors.sort();
}

if (import.meta.main) {
  const paths = new Bun.Glob("{apps,packages,scripts,tests}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({
    onlyFiles: true,
  });
  const sources = new Map<string, string>();
  for (const path of paths) {
    if (/(?:^|\/)(?:node_modules|dist)\//.test(path)) continue;
    sources.set(path, readFileSync(path, "utf8"));
  }
  const errors = checkImportBoundaries(sources);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
