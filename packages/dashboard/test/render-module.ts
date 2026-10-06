// Compile one real TSX module with isolated boundary substitutes. Unlike Bun's
// global module mocks, these cannot change the imports of later test files.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as jsx from "react/jsx-runtime";
import * as ts from "typescript";

export function renderModule(
  path: string,
  dependencies: Record<string, unknown>,
  globals: Record<string, unknown> = {},
): Record<string, unknown> {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(
    code,
    {
      ...globals,
      exports,
      require: (name: string) => {
        if (name === "react/jsx-runtime") return jsx;
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`unexpected render dependency: ${name}`);
      },
    },
    { filename: path },
  );
  return exports;
}
