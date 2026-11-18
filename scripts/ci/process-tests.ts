import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { testFiles } from "./unit-shards.ts";

const root = join(import.meta.dir, "../..");
const allowlistPath = "scripts/ci/process-tests.txt";

function isChildProcessModule(node: ts.Node | undefined): boolean {
  return !!node && ts.isStringLiteralLike(node) && /^(node:)?child_process$/.test(node.text);
}

function onlyTypeSpecifiers(list: ts.NamedImports | ts.NamedExports): boolean {
  return list.elements.length > 0 && list.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyModuleReference(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && onlyTypeSpecifiers(clause));
  }
  const clause = node.importClause;
  if (!clause) return false;
  const bindings = clause.namedBindings;
  return (
    clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) && onlyTypeSpecifiers(bindings))
  );
}

// Scan direct syntax only. Fixtures, comments and type-only imports do not start processes.
export function processRules(path: string, source: string): string[] {
  const rules = new Set<string>();
  function recordBunMember(member: string | undefined): void {
    if (member === "spawn" || member === "spawnSync") rules.add(`Bun.${member}`);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!isTypeOnlyModuleReference(node) && isChildProcessModule(node.moduleSpecifier)) rules.add("child_process");
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun"
    ) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (!clause?.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly) recordBunMember((binding.propertyName ?? binding.name).text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "Bun" &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const binding of node.name.elements) {
        const member = binding.propertyName ?? binding.name;
        if (ts.isIdentifier(member) || ts.isStringLiteralLike(member)) recordBunMember(member.text);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      if (isChildProcessModule(node.moduleReference.expression)) rules.add("child_process");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "spawnSync") rules.add("spawnSync");
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) &&
        isChildProcessModule(node.arguments[0])
      ) {
        rules.add("child_process");
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let member: string | undefined;
      if (ts.isPropertyAccessExpression(node)) member = node.name.text;
      else if (ts.isStringLiteralLike(node.argumentExpression)) member = node.argumentExpression.text;
      if (ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
        recordBunMember(member);
      }
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "$") {
      rules.add("Bun shell template");
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker") {
      rules.add("new Worker");
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest));
  return [...rules].sort();
}

export function checkProcessTests(
  sources: Iterable<readonly [string, string]>,
  allowlist: ReadonlySet<string>,
  baseline?: ReadonlySet<string>,
): string[] {
  const unused = new Set(allowlist);
  const errors: string[] = [];
  for (const [path, source] of sources) {
    const rules = processRules(path, source);
    if (!rules.length) continue;
    if (!unused.delete(path)) errors.push(`${path}: process-spawning test matched ${rules.join(", ")}`);
  }
  for (const path of unused) errors.push(`${path}: remove the unused process-test allowlist entry`);
  if (baseline) {
    for (const path of allowlist) {
      if (!baseline.has(path)) errors.push(`${path}: process-test allowlist entries can only be removed`);
    }
  }
  return errors.sort();
}

function allowlist(text: string): Set<string> {
  return new Set(text.split(/\r?\n/).filter(Boolean));
}

function baseAllowlist(ref: string): Set<string> | undefined {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
    return result.stdout.toString();
  };
  // The commit introducing the guard has no allowlist on its base.
  if (!git(["ls-tree", ref, "--", allowlistPath])) return undefined;
  return allowlist(git(["show", `${ref}:${allowlistPath}`]));
}

if (import.meta.main) {
  const [mode, base] = process.argv.slice(2);
  if (mode !== "--check") throw new Error("Usage: bun scripts/ci/process-tests.ts --check [base]");
  const sources = testFiles().map((path) => [path, readFileSync(join(root, path), "utf8")] as const);
  const entries = allowlist(readFileSync(join(root, allowlistPath), "utf8"));
  const errors = checkProcessTests(sources, entries, base ? baseAllowlist(base) : undefined);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Checked ${sources.length} test files against ${entries.size} process-test exceptions`);
  }
}
