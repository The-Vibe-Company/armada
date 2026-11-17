import { execFileSync } from "node:child_process";

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

try {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: bun scripts/db/check-migrations.ts <base-ref> [head-ref]");
  const head = migrations(process.argv[3] ?? "HEAD");
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
      ? ` Start from the current UTC time (date -u +%Y%m%d%H%M%S) only when it is above ${latest}.`
      : " Start from the current UTC time (date -u +%Y%m%d%H%M%S).";
    errors.push(
      `Renumber each rejected new migration: use distinct valid UTC versions with seconds other than 00${above} and no later than ${newest}, keeping your new migrations in their dependency order.${clock} Then rerun the guard.`,
    );
    throw new Error(errors.join("\n"));
  }
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
