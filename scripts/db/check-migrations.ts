import { execFileSync, spawnSync } from "node:child_process";

// A new version may lead the guard's clock by at most this window. It absorbs
// a local time written as UTC and back-to-back migrations one second apart,
// while a far-future placeholder can never become a base that no later valid
// version can exceed.
const FUTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

function migrations(ref: string): Map<string, string> {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "supabase/migrations"], {
    encoding: "utf8",
  }).trim();
  const result = new Map<string, string>();
  for (const path of paths ? paths.split("\n") : []) {
    if (!path.endsWith(".sql")) continue;
    const match = /^supabase\/migrations\/(\d{14})_.+\.sql$/.exec(path);
    if (!match) throw new Error(`Invalid migration filename: ${path}`);
    result.set(path, match[1] as string);
  }
  return result;
}

function formatVersion(date: Date): string {
  return date.toISOString().split(".")[0]!.replace(/\D/g, "");
}

function isValidVersion(version: string): boolean {
  const date = new Date(version.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z"));
  return Number.isFinite(date.getTime()) && formatVersion(date) === version;
}

// The guard's clock. MIGRATION_GUARD_NOW (ISO 8601) fixes it for tests.
function guardNow(): number {
  const fixed = process.env.MIGRATION_GUARD_NOW;
  if (fixed === undefined) return Date.now();
  const time = Date.parse(fixed);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(fixed) || !Number.isFinite(time))
    throw new Error(`MIGRATION_GUARD_NOW must be a UTC ISO 8601 timestamp: ${fixed}`);
  return time;
}

type DestructiveStatement =
  | { kind: "object"; name: string }
  | { kind: "column" | "enum value"; name: string; lastUsedIn: string | undefined };

const RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(left: string, right: string): number {
  const rightParts = right.slice(1).split(".").map(BigInt);
  for (const [index, part] of left.slice(1).split(".").map(BigInt).entries()) {
    if (part !== rightParts[index]) return part > rightParts[index]! ? 1 : -1;
  }
  return 0;
}

function latestRelease(tags: string): string | undefined {
  return tags
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, "") ?? "")
    .filter((tag) => RELEASE_VERSION.test(tag))
    .sort(compareVersions)
    .at(-1);
}

// Tokenize top-level SQL so comments, strings and function bodies cannot supply
// keywords or statement separators. Preserve spelling for quoted identifiers.
function* sqlStatements(sql: string): Generator<{ tokens: string[]; startsAt: number }> {
  const lexer =
    /--[^\r\n]*|\/\*|((?:[uU]&)?"(?:[^"]|"")*")|([eE]'(?:[^'\\]|\\[\s\S]|'')*'|(?:[uU]&)?'(?:[^']|'')*')|(\$(?:[a-zA-Z_\u0080-\uffff][\w\u0080-\uffff]*)?\$)|[a-zA-Z_\u0080-\uffff][\w$\u0080-\uffff]*|[^\s]/g;
  let tokens: string[] = [];
  let startsAt = 0;
  for (let match = lexer.exec(sql); match; match = lexer.exec(sql)) {
    let token = match[0];
    if (match[3]) {
      const close = sql.indexOf(token, lexer.lastIndex);
      lexer.lastIndex = close < 0 ? sql.length : close + token.length;
      token = sql.slice(match.index, lexer.lastIndex);
    }
    if (token.startsWith("--")) continue;
    if (token === "/*") {
      const delimiters = /\/\*|\*\//g;
      delimiters.lastIndex = lexer.lastIndex;
      let depth = 1;
      for (let part = delimiters.exec(sql); part; part = delimiters.exec(sql)) {
        depth += part[0] === "/*" ? 1 : -1;
        if (depth === 0) break;
      }
      lexer.lastIndex = depth === 0 ? delimiters.lastIndex : sql.length;
      continue;
    }
    if (token === ";") {
      if (tokens.length) yield { tokens, startsAt };
      tokens = [];
    } else {
      if (!tokens.length) startsAt = match.index;
      tokens.push(match[1] || match[2] || match[3] ? token : token.toLowerCase());
    }
  }
  if (tokens.length) yield { tokens, startsAt };
}

function qualifiedName(tokens: readonly (string | undefined)[], start: number) {
  let name: string | undefined;
  let next = start;
  do {
    const token = tokens[next++];
    if (/^u&"/i.test(token ?? "")) {
      const content = token!.slice(3, -1).replaceAll('""', '"');
      let escapeCharacter = "\\";
      if (tokens[next] === "uescape") {
        escapeCharacter = tokens[next + 1]?.slice(1, -1) ?? escapeCharacter;
        next += 2;
      }
      const marker = escapeCharacter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapes = new RegExp(`${marker}(${marker}|[\\da-fA-F]{4}|\\+[\\da-fA-F]{6})`, "g");
      name = content.replace(escapes, (_, value: string) =>
        value === escapeCharacter
          ? escapeCharacter
          : String.fromCodePoint(Number.parseInt(value.replace(/^\+/, ""), 16)),
      );
    } else if (token?.startsWith('"')) {
      name = token.slice(1, -1).replaceAll('""', '"');
    } else {
      name = token && /^[a-z_\u0080-\uffff][\w$\u0080-\uffff]*$/.test(token) ? token : undefined;
    }
    if (tokens[next] !== ".") break;
    next++;
  } while (name !== undefined);
  return { name, next };
}

// Split lists of DROP targets and ALTER TABLE actions, while retaining commas
// inside function signatures, type modifiers and expressions.
function* commaSeparated(tokens: string[]): Generator<string[]> {
  let depth = 0;
  let start = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === "(" || token === "[") depth++;
    if (token === ")" || token === "]") depth--;
    if (token === "," && depth === 0) {
      yield tokens.slice(start, index);
      start = index + 1;
    }
  }
  yield tokens.slice(start);
}

export function destructiveStatements(sql: string): DestructiveStatement[] {
  const statements: DestructiveStatement[] = [];
  for (const { tokens, startsAt } of sqlStatements(sql)) {
    const [verb, kind] = tokens;
    if (verb === "drop" && ["table", "view", "function", "type", "trigger"].includes(kind ?? "")) {
      const start = tokens[2] === "if" && tokens[3] === "exists" ? 4 : 2;
      for (const target of commaSeparated(tokens.slice(start))) {
        const { name } = qualifiedName(target, 0);
        if (name) statements.push({ kind: "object", name });
      }
      continue;
    }
    if (verb !== "alter" || (kind !== "table" && kind !== "type")) continue;
    let start = tokens[2] === "if" && tokens[3] === "exists" ? 4 : 2;
    if (tokens[start] === "only") start++;
    const { name: objectName, next } = qualifiedName(tokens, start);
    if (!objectName) continue;
    start = next + (tokens[next] === "*" ? 1 : 0);
    const previousLineEnd = sql.lastIndexOf("\n", startsAt - 1);
    const previousLineStart = previousLineEnd > 0 ? sql.lastIndexOf("\n", previousLineEnd - 1) + 1 : 0;
    const lastUsedIn = /^[ \t]*-- contract: last-used-in (v\d+\.\d+\.\d+)[ \t]*\r?\n[ \t]*$/.exec(
      sql.slice(previousLineStart, startsAt),
    )?.[1];
    for (const [action, target, ...rest] of commaSeparated(tokens.slice(start))) {
      if (kind === "type") {
        if (action === "rename" && target === "value" && rest[0]) {
          statements.push({ kind: "enum value", name: `${objectName}.${rest[0]}`, lastUsedIn });
        }
        continue;
      }
      if (action === "rename" && target === "to") {
        statements.push({ kind: "object", name: objectName });
      } else if (action === "drop" && target !== "constraint") {
        const column = target === "column" ? rest : [target, ...rest];
        const { name } = qualifiedName(column, column[0] === "if" && column[1] === "exists" ? 2 : 0);
        if (name) statements.push({ kind: "column", name: `${objectName}.${name}`, lastUsedIn });
      } else if (action === "rename" && target !== "constraint") {
        const column = target === "column" ? rest : [target, ...rest];
        const { name, next: afterName } = qualifiedName(column, 0);
        if (name && column[afterName] === "to") {
          statements.push({ kind: "column", name: `${objectName}.${name}`, lastUsedIn });
        }
      }
    }
  }
  return statements;
}

type DropSources = {
  base: string;
  latestRelease: string;
  packageVersion: string;
  references: (name: string, ref: string) => readonly string[];
};

export function dropSafety(statements: readonly DestructiveStatement[], sources: DropSources): string[] {
  const errors: string[] = [];
  for (const statement of statements) {
    if (statement.kind === "object") {
      for (const ref of [sources.base, sources.latestRelease]) {
        const files = sources.references(statement.name, ref);
        if (files.length) errors.push(`${statement.name} is still referenced at ${ref}: ${files.join(", ")}`);
      }
      continue;
    }
    const version = statement.lastUsedIn;
    if (
      !version ||
      !RELEASE_VERSION.test(version) ||
      compareVersions(version, sources.latestRelease) > 0 ||
      compareVersions(version, sources.packageVersion) >= 0
    ) {
      errors.push(
        `${statement.kind} ${statement.name} requires -- contract: last-used-in vX.Y.Z directly above the statement, ` +
          `at or below ${sources.latestRelease} and older than ${sources.packageVersion}.`,
      );
    }
  }
  return errors;
}

const SOURCE_PATHS = [
  "packages",
  "apps",
  "scripts",
  ":(exclude)packages/core/src/database.types.ts",
  ...["test", "tests", "__tests__", "e2e", "fixture", "fixtures", "__fixtures__", "test-fixtures", "node_modules"].map(
    (directory) => `:(exclude,glob)**/${directory}/**`,
  ),
  ...["test", "spec", "probe", "fixture", "fixtures"].map((suffix) => `:(exclude,glob)**/*.${suffix}.*`),
];

function gitReferences(name: string, ref: string): string[] {
  const result = spawnSync("git", ["grep", "-l", "-z", "-I", "-F", "-w", "-e", name, ref, "--", ...SOURCE_PATHS], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stderr) return [];
  if (result.status !== 0) throw new Error(`Could not search ${ref} for ${name}: ${result.stderr || result.signal}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(ref.length + 1));
}

function checkDrops(paths: string[], base: string, head: string): void {
  const changes = paths.flatMap((path) => {
    const statements = destructiveStatements(execFileSync("git", ["show", `${head}:${path}`], { encoding: "utf8" }));
    return statements.length ? [{ path, statements }] : [];
  });
  if (!changes.length) return;
  const tag = latestRelease(
    execFileSync("git", ["ls-remote", "--tags", "--refs", "origin", "v*"], { encoding: "utf8" }),
  );
  if (!tag) throw new Error("Cannot check destructive migrations: origin has no stable vX.Y.Z release tag.");
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", "tag", tag], { stdio: "pipe" });
  const packageVersion = `v${JSON.parse(execFileSync("git", ["show", `${head}:package.json`], { encoding: "utf8" })).version}`;
  if (!RELEASE_VERSION.test(packageVersion)) throw new Error(`Invalid package version: ${packageVersion}`);
  const sources = {
    base,
    latestRelease: tag,
    packageVersion,
    references: (name: string, ref: string) => gitReferences(name, ref === tag ? `refs/tags/${tag}` : ref),
  };
  const errors = changes.flatMap(({ path, statements }) =>
    dropSafety(statements, sources).map((error) => `${path}: ${error}`),
  );
  if (errors.length) throw new Error(errors.join("\n"));
}

function main(): void {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: bun scripts/db/check-migrations.ts <base-ref> [head-ref]");
  const headRef = process.argv[3] ?? "HEAD";
  const head = migrations(headRef);
  const baseline = migrations(base);
  const errors: string[] = [];
  const versions = new Map<string, string>();
  const latest = [...baseline.values()].sort().at(-1);
  const now = guardNow();
  const newest = formatVersion(new Date(now + FUTURE_WINDOW_MS));
  for (const [path, version] of head) {
    const previous = versions.get(version);
    if (previous) errors.push(`Duplicate migration version ${version}: ${previous}, ${path}`);
    versions.set(version, path);
    if (baseline.has(path)) continue;
    if (!isValidVersion(version)) {
      errors.push(`New migration ${path} must have a valid UTC timestamp as its version.`);
    } else if (version.endsWith("00")) {
      errors.push(`New migration ${path} has a minute-rounded version. Use UTC seconds other than 00.`);
    } else if (version > newest) {
      errors.push(
        `New migration ${path} is more than 24 hours ahead of the current UTC time. Use a version no later than ${newest}.`,
      );
    }
    if (latest && version <= latest) {
      errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
    }
  }
  if (errors.length) {
    // The current UTC time alone is not enough: the base may already hold a
    // version ahead of the clock, so the instruction states both bounds.
    const above = latest ? `, greater than ${latest} (the latest version on ${base})` : "";
    const clock = latest
      ? ` Start from the current UTC time (date -u +%Y%m%d%H%M%S) when it is above ${latest}; otherwise pick a time well inside the range rather than right after ${latest}, so concurrent authors do not collide.`
      : " Start from the current UTC time (date -u +%Y%m%d%H%M%S).";
    errors.push(
      `Renumber each rejected new migration: use distinct valid UTC versions with seconds other than 00${above} and no later than ${newest}, keeping your new migrations in their dependency order.${clock} Then rerun the guard.`,
    );
    throw new Error(errors.join("\n"));
  }
  checkDrops(
    [...head.keys()].filter((path) => !baseline.has(path)),
    base,
    headRef,
  );
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
