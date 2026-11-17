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

function parseVersion(version: string): number | undefined {
  const iso = version.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(iso);
  if (Number.isFinite(date.getTime()) && formatVersion(date) === version) return date.getTime();
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

// The next free second at or after now, above every version inside the window.
// Versions beyond the window must be renamed, so they do not bound it.
function suggestedVersion(versions: Iterable<string>, now: number): string | undefined {
  const limit = now + FUTURE_WINDOW_MS;
  let time = now;
  for (const version of versions) {
    const timestamp = parseVersion(version);
    if (timestamp !== undefined && timestamp <= limit) time = Math.max(time, timestamp + 1000);
  }
  const next = new Date(time - (time % 1000));
  if (next.getUTCSeconds() === 0) next.setUTCSeconds(1);
  if (next.getTime() <= limit) return formatVersion(next);
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
    } else if (version > newest) {
      errors.push(
        `New migration ${path} is more than 24 hours ahead of the current UTC time. Use a version no later than ${newest}.`,
      );
      needsTimestamp = true;
    }
    if (latest && version <= latest) {
      errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
    }
  }
  if (needsTimestamp) {
    const suggestion = suggestedVersion([...baseline.values(), ...head.values()], now);
    errors.push(
      suggestion
        ? `Use migration version ${suggestion} for the first rename. Preserve unapplied migration dependency order and rerun the guard.`
        : `No version within 24 hours of the current UTC time is above ${latest ?? "the base"}; a base migration is too far ahead.`,
    );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
