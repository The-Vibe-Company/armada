import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tableOwner } from "./tables";

const allowlistPath = "scripts/ci/table-owners-allowlist.txt";
const root = resolve(import.meta.dir, "../..");
const identifier = String.raw`(?:"[a-z_]\w*"|[a-z_]\w*\b)`;
const publicTable = String.raw`(?:(?:"public"|public)\s*\.\s*)?(${identifier})(?![\w"]|\s*\.)`;
const sqlWrites = [
  ["insert", new RegExp(String.raw`\binsert\s+into\s+(?:only\s+)?${publicTable}`, "gi")],
  [
    "update",
    new RegExp(String.raw`\bupdate\s+(?:only\s+)?${publicTable}(?:\s+(?:as\s+)?${identifier})?\s+set\b`, "gi"),
  ],
  ["delete", new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${publicTable}`, "gi")],
] as const;
const supabaseWrite = /\.\s*from\s*\(\s*(["'`])([a-z_]\w*)\1\s*,?\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/g;

function* tableWrites(path: string, source: string) {
  const writes = [
    ...sqlWrites.flatMap(([verb, pattern]) =>
      Array.from(source.matchAll(pattern), (match) => ({
        verb,
        table: match[1]?.replaceAll('"', "").toLowerCase() ?? "",
        index: match.index,
      })),
    ),
    ...Array.from(source.matchAll(supabaseWrite), (match) => ({
      verb: match[3],
      table: match[2] ?? "",
      index: match.index,
    })),
  ];
  for (const { verb, table, index } of writes) {
    const owner = tableOwner(table);
    if (!owner || owner.files.some((glob) => glob.match(path))) continue;
    yield { key: `${path}\t${table}\t${verb}`, line: source.slice(0, index).split("\n").length, owner: owner.paths };
  }
}

export function checkTableOwners(
  sources: Iterable<readonly [string, string]>,
  allowlist: readonly string[],
  baseAllowlist: readonly string[] = allowlist,
): string[] {
  const errors: string[] = [];
  const remaining = counts(allowlist);
  const baseline = counts(baseAllowlist);
  for (const [key, count] of remaining) {
    if (count > (baseline.get(key) ?? 0)) errors.push(`Allowlist grew: ${key}`);
  }
  for (const [file, source] of sources) {
    for (const { key, line, owner } of tableWrites(file, source)) {
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
      } else {
        const [, table, verb] = key.split("\t");
        errors.push(`${file}:${line}: ${verb} on ${table} belongs to ${owner.join(", ")}`);
      }
    }
  }
  for (const [key, count] of remaining) {
    if (count > 0) errors.push(`Remove ${count} stale exception(s) from ${allowlistPath}: ${key}`);
  }
  return errors;
}

function counts(entries: readonly string[]) {
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry, (result.get(entry) ?? 0) + 1);
  return result;
}

function entries(content: string) {
  return content.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}

function* repositorySources() {
  const paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.ts", "*.tsx");
  for (const path of new Set(paths.split("\0"))) {
    if (!path || /(?:^|\/)(?:test|tests|__tests__|e2e|fixtures)\/|\.(?:d|spec|test)\.tsx?$/.test(path)) continue;
    try {
      yield [path, readFileSync(resolve(root, path), "utf8")] as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

if (import.meta.main) {
  const allowlist = entries(readFileSync(resolve(root, allowlistPath), "utf8"));
  const mergeBase = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], { cwd: root });
  const base = process.env.TABLE_OWNERS_BASE || mergeBase.stdout.toString().trim();
  // The first commit introducing the guard establishes its baseline.
  const baseAllowlist =
    base && git("ls-tree", base, "--", allowlistPath) ? entries(git("show", `${base}:${allowlistPath}`)) : allowlist;
  const errors = checkTableOwners(repositorySources(), allowlist, baseAllowlist);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
