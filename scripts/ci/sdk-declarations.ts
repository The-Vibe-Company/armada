import { join, posix } from "node:path";
import ts from "typescript";
import { SDK_PACKAGE, sdkDeclarations } from "../npm.ts";

const root = join(import.meta.dir, "../..");
const consumer = "/armada-sdk-smoke";

/** Check the smoke as an ESM consumer of the published package in a virtual install. */
export function checkSdkDeclarations(declarations: string, smoke: string): readonly ts.Diagnostic[] {
  const smokePath = posix.join(consumer, "smoke.ts");
  const sdkDir = posix.join(consumer, "node_modules", SDK_PACKAGE);
  const files = new Map([
    [smokePath, smoke],
    [posix.join(consumer, "package.json"), JSON.stringify({ type: "module" })],
    [
      posix.join(sdkDir, "package.json"),
      JSON.stringify({ type: "module", exports: { ".": { types: "./index.d.ts" } } }),
    ],
    [posix.join(sdkDir, "index.d.ts"), declarations],
  ]);
  const directories = new Set([consumer, posix.join(consumer, "node_modules"), posix.dirname(sdkDir), sdkDir]);

  // Match the isolated consumer tsconfig in scripts/npm-smoke.sh.
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile } = host;
  const libDir = posix.dirname(host.getDefaultLibFileName(options).replaceAll("\\", "/"));
  const isBundledLib = (path: string) =>
    posix.dirname(path) === libDir && /^lib\..+\.d\.ts$/.test(posix.basename(path));
  host.getCurrentDirectory = () => consumer;
  host.directoryExists = (path) => directories.has(path) || path === libDir;
  host.fileExists = (path) => files.has(path) || (isBundledLib(path) && fileExists(path));
  host.readFile = (path) => files.get(path) ?? (isBundledLib(path) ? readFile(path) : undefined);
  return ts.getPreEmitDiagnostics(ts.createProgram([smokePath], options, host));
}

if (import.meta.main) {
  const declarations = await sdkDeclarations(join(root, "packages/sdk/src/index.ts"));
  const smoke = await Bun.file(join(root, "packages/sdk/test/npm-smoke.types.ts")).text();
  const diagnostics = checkSdkDeclarations(declarations, smoke);
  if (diagnostics.length > 0) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => consumer,
        getNewLine: () => "\n",
      }),
    );
    process.exitCode = 1;
  } else {
    console.log("SDK emitted declarations passed the npm smoke typecheck.");
  }
}
