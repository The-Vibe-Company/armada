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

// A free version strictly between two neighbours, at or after now when the
// interval allows it, never on a whole minute and never beyond the window.
function freeVersion(after: number, before: number, now: number): string | undefined {
  const lower = after + 1000;
  const upper = Math.min(before - 1000, now + FUTURE_WINDOW_MS);
  const start = Math.max(lower, Math.min(now, upper));
  const next = new Date(start - (start % 1000));
  if (next.getTime() < lower) next.setTime(next.getTime() + 1000);
  if (next.getUTCSeconds() === 0) next.setTime(next.getTime() + (next.getTime() + 1000 <= upper ? 1000 : -1000));
  if (next.getTime() >= lower && next.getTime() <= upper) return formatVersion(next);
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
  const renames = new Set<string>();
  for (const [path, version] of head) {
    const previous = versions.get(version);
    if (previous) errors.push(`Duplicate migration version ${version}: ${previous}, ${path}`);
    versions.set(version, path);
    if (baseline.has(path)) continue;
    if (parseVersion(version) === undefined) {
      errors.push(`New migration ${path} must have a valid UTC timestamp as its version.`);
      renames.add(path);
    } else if (version.endsWith("00")) {
      errors.push(`New migration ${path} has a minute-rounded version. Use UTC seconds other than 00.`);
      renames.add(path);
    } else if (version > newest) {
      errors.push(
        `New migration ${path} is more than 24 hours ahead of the current UTC time. Use a version no later than ${newest}.`,
      );
      renames.add(path);
    }
    if (latest && version <= latest) {
      errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
    }
  }
  if (renames.size) {
    // Each rename keeps its file's place among the unapplied migrations: it
    // lands above the base and the preceding kept or renamed migration, and
    // below the next kept one, so dependency order survives the rename.
    const additions = [...head].filter(([path]) => !baseline.has(path)).sort(([, a], [, b]) => a.localeCompare(b));
    const floor = latest ? (parseVersion(latest) ?? -Infinity) : -Infinity;
    let previous = floor;
    let previousName = latest ? `${latest} on ${base}` : undefined;
    for (const [index, [path, version]] of additions.entries()) {
      if (!renames.has(path)) {
        const time = parseVersion(version) as number;
        if (time > previous) [previous, previousName] = [time, path];
        continue;
      }
      const next = additions
        .slice(index + 1)
        .find(([other, v]) => !renames.has(other) && (parseVersion(v) as number) > floor);
      const suggestion = freeVersion(previous, next ? (parseVersion(next[1]) as number) : Infinity, now);
      if (suggestion) {
        errors.push(
          `Use migration version ${suggestion} for ${path}. Preserve unapplied migration dependency order and rerun the guard.`,
        );
        [previous, previousName] = [parseVersion(suggestion) as number, path];
      } else {
        errors.push(
          next || previous > floor
            ? `No free version for ${path} within 24 hours of the current UTC time between ${previousName ?? "the base"} and ${next?.[0] ?? "the window end"}. Resequence those unapplied migrations.`
            : `No version within 24 hours of the current UTC time is above ${latest ?? "the base"}; a base migration is too far ahead.`,
        );
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
