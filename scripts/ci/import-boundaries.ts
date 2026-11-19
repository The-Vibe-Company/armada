import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import ts from "typescript";
import core from "../../packages/core/package.json";

const coreSource = "packages/core/src/";
const coreEntries = Object.entries(core.exports).map(
  ([key, value]) => [core.name + key.slice(1), join("packages/core", value)] as const,
);
const providers = ["provider-boat", "provider-modal"];
const sourceExtension = /\.[cm]?[jt]sx?$/;
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

const existingProviderImports = new Set([
  "packages/agent-runtime/test/github-parent.test.ts -> ../../provider-boat/src/native-cwd.ts",
  "packages/core/test/golden-os.probe.ts -> ../../provider-modal/src/ssh.ts",
  "packages/core/test/golden-snapshot-retirement.release.ts -> ../../provider-modal/src/store.ts",
  "packages/mcp-server/test/exec-selected-org-api.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/lifecycle-driver-postgres.release.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/lifecycle-review.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/mcp-before-resume.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/mcp-codex-bridge.fixture.ts -> ../../provider-boat/src/native-cwd.ts",
  "packages/mcp-server/test/runtime-resume.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/sandbox-activity.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/sandbox-lifecycle.test.ts -> ../../provider-boat/test/support.ts",
  "packages/mcp-server/test/server-workers.test.ts -> ../../provider-boat/test/support.ts",
  "scripts/golden-os-image.ts -> ../packages/provider-modal/src/index.ts",
]);

function localTarget(file: string, specifier: string) {
  if (specifier.startsWith(".")) return join(dirname(file), specifier);
  if (file.startsWith("apps/dashboard/") && specifier.startsWith("@/")) {
    return join("apps/dashboard/src", specifier.slice(2));
  }
  return normalize(specifier);
}

function providerInternal(
  file: string,
  specifier: string,
  target: string,
  workspaceEntries: ReadonlyMap<string, string>,
) {
  for (const provider of providers) {
    const directory = `packages/${provider}/`;
    if (file.startsWith(directory)) continue;
    if (target.startsWith(directory) || target === `packages/${provider}`) return true;
    if (specifier.startsWith(`@armada/${provider}/`) && !workspaceEntries.has(specifier)) return true;
  }
  return false;
}

function resolveModule(target: string, modules: ReadonlyMap<string, unknown>) {
  const stem = target.replace(sourceExtension, "");
  return [target, ...extensions.map((ext) => stem + ext), ...extensions.map((ext) => `${target}/index${ext}`)].find(
    (candidate) => modules.has(candidate),
  );
}

function addTypeScriptImports(file: string, source: string, imports: Set<string>) {
  function visit(node: ts.Node) {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isExternalModuleReference(node)) {
      specifier = node.expression;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) imports.add(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
}

export function checkImportBoundaries(
  sources: ReadonlyMap<string, string>,
  workspaceEntries: ReadonlyMap<string, string> = new Map(coreEntries),
) {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const modules = new Map<string, { imports: Set<string>; runtimeImports: Set<string> }>();
  const errors: string[] = [];
  const report = (file: string, specifier: string, rule: string) => errors.push(`${file}: ${rule}: ${specifier}`);

  for (const [file, source] of sources) {
    const transpiler = /\.(?:tsx|jsx?)$/.test(file) ? transpilers.tsx : transpilers.ts;
    const runtimeImports = new Set(transpiler.scanImports(source.replace(/^#![^\n]*/, "")).map(({ path }) => path));
    const imports = new Set(runtimeImports);
    addTypeScriptImports(file, source, imports);
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
          /^(?:@armada\/core\/src|packages\/core\/src)\/(?:vault-store|golden-create|routine-service|template-service)(?:\.|$)/.test(
            target,
          ) ||
          /^(@armada\/auth|packages\/auth\/src)(?:\/|$)/.test(target))
      ) {
        report(file, specifier, "dashboard-service-import");
      }
      if (
        providerInternal(file, specifier, target, workspaceEntries) &&
        !existingProviderImports.has(`${file} -> ${specifier}`)
      ) {
        report(file, specifier, "provider-private-import");
      }
    }
    modules.set(file, { imports, runtimeImports });
  }

  const serverEntry = join("packages/core", core.exports["./server"]);
  const pending = coreEntries.map(([, file]) => file).filter((file) => file !== serverEntry);
  const visited = new Set<string>();
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    const module = modules.get(file);
    if (!module) continue;
    for (const specifier of module.imports) {
      const target =
        workspaceEntries.get(specifier) ?? localTarget(file, specifier.replace(/^@armada\/core\/src\//, coreSource));
      const resolved = resolveModule(target, modules);
      if (specifier.startsWith("node:") || target === serverEntry || resolved === serverEntry) {
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
  const workspaceEntries = new Map<string, string>(coreEntries);
  for (const path of new Bun.Glob("packages/*/package.json").scanSync({ onlyFiles: true })) {
    const manifest: { name: string; exports?: string | Record<string, string> } = JSON.parse(
      readFileSync(path, "utf8"),
    );
    const entries = typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
    for (const [key, value] of Object.entries(entries)) {
      workspaceEntries.set(manifest.name + key.slice(1), join(dirname(path), value));
    }
  }
  const errors = checkImportBoundaries(sources, workspaceEntries);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
