import { lstatSync, readFileSync } from "node:fs";
import ts from "typescript";
import {
  isNativePathSource,
  isProviderBranchSource,
  providerBranchPattern,
  scanNativePaths,
  testPaths,
} from "../metrics/architecture-rules";

const serverSource = /^packages\/mcp-server\/src\//;
const routeTables = /^packages\/mcp-server\/src\/control[^/]*\.ts$/;

const controlPath = "packages/mcp-server/src/control.ts";
const servePath = "packages/mcp-server/src/serve.ts";
const barrelPath = "packages/core/src/index.ts";
const commandsPath = "packages/cli/src/commands/index.ts";
const appendPoints = new Set([controlPath, servePath, barrelPath, commandsPath]);

type Occurrence = { index: number; text: string };

function registrations(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest);
  const entries: ts.Node[] = [];
  function addMounts(expression: ts.Expression) {
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) addMounts(element);
    } else if (ts.isSpreadElement(expression) || ts.isParenthesizedExpression(expression)) {
      addMounts(expression.expression);
    } else if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const callee = expression.expression;
      if (callee.getText(source) === "assembly.mounts") return;
      if (callee.name.text === "concat") {
        addMounts(callee.expression);
        for (const argument of expression.arguments) addMounts(argument);
      } else {
        entries.push(expression);
      }
    } else {
      entries.push(expression);
    }
  }

  function visit(node: ts.Node) {
    if (path === controlPath) {
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) entries.push(node.expression);
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const routeMap = callee === "defineRoutes" ? node.arguments[1] : node.arguments[0];
        if (
          (callee === "defineRoutes" || callee === "registerRoutes") &&
          routeMap &&
          ts.isObjectLiteralExpression(routeMap)
        ) {
          entries.push(...routeMap.properties.map((property) => property.name ?? property));
        }
        if (/^(?:controlRoutes|routes)\.set$/.test(callee) && node.arguments[0]) entries.push(node.arguments[0]);
      }
      if (ts.isVariableDeclaration(node) && /^(?:controlRoutes|routes|routeMap)$/.test(node.name.getText(source))) {
        if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
          entries.push(...node.initializer.properties.map((property) => property.name ?? property));
        }
      }
    }
    if (path === servePath) {
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === "routes") {
        addMounts(node.initializer);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        if (/^(?:[\w$.]+\.)?(?:mounts|workers\.beforeListen)\.push$/.test(callee)) entries.push(...node.arguments);
        if (/^(?:[\w$.]+\.)?workers\.(?:managed|isolated|background)\.set$/.test(callee) && node.arguments[0]) {
          entries.push(node.arguments[0]);
        }
        if (/^start\w*Workers?$|\.startBackground$/.test(callee)) entries.push(node.expression);
      }
    }
    if (path === barrelPath && ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) entries.push(...node.exportClause.elements);
      else entries.push(node);
    }
    if (
      path === commandsPath &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "commands" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      entries.push(...node.initializer.elements);
    }
    node.forEachChild(visit);
  }
  visit(source);
  return entries.map((node) => ({ index: node.getStart(source), text: node.getText(source) }));
}

type Counter = {
  name: string;
  includes: (path: string) => boolean;
} & ({ pattern: RegExp } | { scan: (path: string, content: string) => Iterable<Occurrence> });

const counters: Record<string, Counter> = {
  "provider-branch": {
    name: "provider-branch",
    includes: isProviderBranchSource,
    pattern: providerBranchPattern,
  },
  "versioned-route": {
    name: "versioned-route",
    includes: (path) => routeTables.test(path),
    pattern: /(["'])\/?[\w/{}-]*-v\d+(?:\/[\w/{}-]*)?\1/g,
  },
  "deprecation-header": {
    name: "deprecation-header",
    includes: (path) => serverSource.test(path),
    pattern: /(["'`])(?:deprecation|sunset)\1|\b(?:deprecation|sunset)\b(?=\s*:)/gi,
  },
  "native-path": {
    name: "native-path",
    includes: isNativePathSource,
    scan: scanNativePaths,
  },
  "append-point": {
    name: "append-point",
    includes: (path) => appendPoints.has(path),
    scan: registrations,
  },
};

const activeCounters = Object.values(counters);
type Files = ReadonlyMap<string, string>;

function isNonTestTypeScript(path: string) {
  return path.endsWith(".ts") && !testPaths.test(path);
}

function inScope(path: string) {
  return isNonTestTypeScript(path) || isNativePathSource(path) || isProviderBranchSource(path);
}

function* matches(counter: Counter, files: Files) {
  for (const [path, content] of files) {
    if (!counter.includes(path)) continue;
    if (counter.name !== "native-path" && counter.name !== "provider-branch" && !isNonTestTypeScript(path)) continue;
    if ("scan" in counter) {
      for (const occurrence of counter.scan(path, content)) yield { path, content, ...occurrence };
    } else {
      for (const match of content.matchAll(counter.pattern))
        yield { path, content, index: match.index, text: match[0] };
    }
  }
}

function count(counter: Counter, files: Files) {
  let total = 0;
  for (const _match of matches(counter, files)) total++;
  return total;
}

function matchContext({ content, index, text }: { content: string; index: number; text: string }) {
  const from = index === 0 ? 0 : content.lastIndexOf("\n", index - 1) + 1;
  const to = content.indexOf("\n", index + text.length);
  return JSON.stringify([text, content.slice(from, to === -1 ? undefined : to).trim()]);
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function take(counts: Map<string, number>, key: string) {
  const available = counts.get(key) ?? 0;
  if (available === 0) return false;
  counts.set(key, available - 1);
  return true;
}

export function compare(base: Files | undefined, head: Files) {
  return activeCounters.map((counter) => {
    const before = base === undefined ? undefined : count(counter, base);
    const after = count(counter, head);
    const added: { path: string; line: number; text: string }[] = [];
    if (base !== undefined && before !== undefined && after > before) {
      const sameFile = new Map<string, number>();
      const sameLine = new Map<string, number>();
      const sameToken = new Map<string, number>();
      for (const match of matches(counter, base)) {
        const context = matchContext(match);
        increment(sameFile, match.path + "\0" + context);
        increment(sameLine, context);
        increment(sameToken, match.text);
      }
      const movedOrNew = [];
      for (const match of matches(counter, head)) {
        const context = matchContext(match);
        if (take(sameFile, match.path + "\0" + context)) {
          take(sameLine, context);
          take(sameToken, match.text);
        } else {
          movedOrNew.push({ match, context });
        }
      }
      const changedLines = [];
      for (const { match, context } of movedOrNew) {
        if (take(sameLine, context)) take(sameToken, match.text);
        else changedLines.push(match);
      }
      for (const { path, content, index, text } of changedLines) {
        if (!take(sameToken, text)) {
          added.push({ path, line: content.slice(0, index).split("\n").length, text });
        }
      }
    }
    return { name: counter.name, before, after, added };
  });
}

function git(args: string[], options: { stdin?: string; exitOne?: boolean } = {}) {
  const result = Bun.spawnSync(["git", ...args], {
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stderr: "pipe",
  });
  if (result.exitCode === 0 || (options.exitOne && result.exitCode === 1)) return result.stdout;
  throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
}

function readHead() {
  const paths = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0");
  const files = new Map<string, string>();
  for (const path of paths) {
    if (!inScope(path) || files.has(path) || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    files.set(path, readFileSync(path, "utf8"));
  }
  return files;
}

function readBase(base: string) {
  const candidates = git(
    [
      "grep",
      "--text",
      "-ilz",
      "-E",
      "-e",
      "boat|modal|docker|switch|-v[0-9]|deprecation|sunset|agent|native|transport",
      base,
      "--",
      "*.ts",
      "*.tsx",
    ],
    { exitOne: true },
  )
    .toString()
    .split("\0")
    .filter((object) => object && inScope(object.slice(base.length + 1)));
  const fixedPaths = git(["ls-tree", "--name-only", "-z", base, "--", ...appendPoints])
    .toString()
    .split("\0")
    .filter(Boolean);
  const objects = [...new Set([...candidates, ...fixedPaths.map((path) => `${base}:${path}`)])];
  const files = new Map<string, string>();
  if (objects.length === 0) return files;

  const output = git(["cat-file", "-z", "--batch"], { stdin: objects.join("\0") + "\0" });
  let offset = 0;
  for (const object of objects) {
    const headerEnd = output.indexOf(10, offset);
    const header = /^\S+ blob (\d+)$/.exec(output.toString("utf8", offset, headerEnd));
    if (!header) throw new Error("Expected a blob from git cat-file for " + object);
    const end = headerEnd + 1 + Number(header[1]);
    if (output[end] !== 10) throw new Error("Incomplete blob from git cat-file for " + object);
    files.set(object.slice(base.length + 1), output.toString("utf8", headerEnd + 1, end));
    offset = end + 1;
  }
  return files;
}

if (import.meta.main) {
  const requestedBase = Bun.argv[2];
  const base = git(
    [
      "rev-parse",
      "--verify",
      ...(requestedBase === undefined ? ["--quiet"] : []),
      "--end-of-options",
      `${requestedBase ?? "origin/main"}^{commit}`,
    ],
    {
      exitOne: requestedBase === undefined,
    },
  )
    .toString()
    .trim();
  if (!base) console.log("No origin/main available. Showing working-tree counts.");
  for (const { name, before, after, added } of compare(base ? readBase(base) : undefined, readHead())) {
    console.log(before === undefined ? `${name}: ${after}` : `${name}: base ${before}, head ${after}`);
    for (const { path, line, text } of added) console.error(`  ${path}:${line}: ${text.replace(/\s+/g, " ")}`);
    if (added.length > 0 || (name === "native-path" && after !== 0)) process.exitCode = 1;
  }
}
