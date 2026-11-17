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

// `count` ascending free versions strictly between two neighbours, never on a
// whole minute and never beyond the window. They start at now when the
// interval leaves room for all of them after it; otherwise they pack against
// the upper neighbour. Undefined when the interval cannot hold them all.
function freeVersions(after: number, before: number, now: number, count: number): string[] | undefined {
  const lower = Math.ceil((after + 1) / 1000) * 1000;
  const upper = Math.floor(Math.min(before - 1, now + FUTURE_WINDOW_MS) / 1000) * 1000;
  const valid = (time: number) => new Date(time).getUTCSeconds() !== 0;
  const forward: number[] = [];
  for (let time = Math.max(lower, Math.ceil(now / 1000) * 1000); time <= upper && forward.length < count; time += 1000)
    if (valid(time)) forward.push(time);
  if (forward.length === count) return forward.map((time) => formatVersion(new Date(time)));
  const backward: number[] = [];
  for (let time = upper; time >= lower && backward.length < count; time -= 1000)
    if (valid(time)) backward.unshift(time);
  if (backward.length === count) return backward.map((time) => formatVersion(new Date(time)));
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
    // Renames keep their files' place among the unapplied migrations. Each run
    // of consecutive rejected files is allocated as one group, above the base
    // and the preceding kept migration and below the next kept one, so
    // applying every suggestion preserves dependency order. A group that does
    // not fit gets no partial assignment.
    const additions = [...head].filter(([path]) => !baseline.has(path)).sort(([, a], [, b]) => a.localeCompare(b));
    const floor = latest ? (parseVersion(latest) ?? -Infinity) : -Infinity;
    let previous = floor;
    let previousName = latest ? `${latest} on ${base}` : undefined;
    let group: string[] = [];
    const allocate = (next: [string, number] | undefined) => {
      if (!group.length) return;
      const suggestions = freeVersions(previous, next ? next[1] : Infinity, now, group.length);
      if (suggestions) {
        for (const [index, path] of group.entries())
          errors.push(
            `Use migration version ${suggestions[index]} for ${path}. Preserve unapplied migration dependency order and rerun the guard.`,
          );
      } else {
        errors.push(
          next || previous > floor
            ? `No free version for ${group.join(", ")} within 24 hours of the current UTC time between ${previousName ?? "the base"} and ${next?.[0] ?? "the window end"}. Resequence those unapplied migrations.`
            : `No version within 24 hours of the current UTC time is above ${latest ?? "the base"}; a base migration is too far ahead.`,
        );
      }
      group = [];
    };
    for (const [path, version] of additions) {
      if (renames.has(path)) {
        group.push(path);
        continue;
      }
      // A kept file at or below the base already fails; it bounds nothing.
      const time = parseVersion(version) as number;
      if (time <= floor) continue;
      allocate([path, time]);
      if (time > previous) [previous, previousName] = [time, path];
    }
    allocate(undefined);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
