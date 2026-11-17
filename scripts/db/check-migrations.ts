import { execFileSync } from "node:child_process";

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

function parseVersion(version: string): number | undefined {
  const iso = version.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(iso);
  if (Number.isFinite(date.getTime()) && formatVersion(date) === version) return date.getTime();
}

function suggestedVersion(versions: Iterable<string>): string | undefined {
  let time = Date.now();
  for (const version of versions) {
    const timestamp = parseVersion(version);
    if (timestamp !== undefined) time = Math.max(time, timestamp + 1000);
  }
  const next = new Date(time);
  if (next.getUTCSeconds() === 0) next.setUTCSeconds(1);
  if (next.getUTCFullYear() <= 9999) return formatVersion(next);
}

try {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: bun scripts/db/check-migrations.ts <base-ref> [head-ref]");
  const head = migrations(process.argv[3] ?? "HEAD");
  const baseline = migrations(base);
  const errors: string[] = [];
  const versions = new Map<string, string>();
  const latest = [...baseline.values()].sort().at(-1);
  let needsTimestamp = false;
  for (const [path, version] of head) {
    const previous = versions.get(version);
    if (previous) errors.push(`Duplicate migration version ${version}: ${previous}, ${path}`);
    versions.set(version, path);
    if (baseline.has(path)) continue;
    if (parseVersion(version) === undefined) {
      errors.push(`New migration ${path} must have a valid UTC timestamp as its version.`);
      needsTimestamp = true;
    } else if (version.endsWith("00")) {
      errors.push(`New migration ${path} has a minute-rounded version. Use UTC seconds other than 00.`);
      needsTimestamp = true;
    }
    if (latest && version <= latest) {
      errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
    }
  }
  if (needsTimestamp) {
    const suggestion = suggestedVersion([...baseline.values(), ...head.values()]);
    if (suggestion) errors.push(`Use migration version ${suggestion} for the first rename, then rerun the guard.`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
