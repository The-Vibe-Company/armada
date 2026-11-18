import { execFileSync } from "node:child_process";

// A new version may lead the guard's clock by at most this window. It absorbs
// a local time written as UTC and back-to-back migrations one second apart,
// while a far-future placeholder can never become a base that no later valid
// version can exceed.
export const FUTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function migrations(ref: string): Map<string, string> {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", ref, "--", "supabase/migrations"], {
    encoding: "utf8",
  });
  const result = new Map<string, string>();
  for (const path of paths.split("\0")) {
    if (!path.endsWith(".sql")) continue;
    const match = /^supabase\/migrations\/(\d{14})_.+\.sql$/.exec(path);
    if (!match) throw new Error(`Invalid migration filename: ${path}`);
    result.set(path, match[1] as string);
  }
  return result;
}

export function formatVersion(date: Date): string {
  return date.toISOString().split(".")[0]!.replace(/\D/g, "");
}

export function versionDate(version: string): Date {
  return new Date(version.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z"));
}

export function isValidVersion(version: string): boolean {
  const date = versionDate(version);
  return Number.isFinite(date.getTime()) && formatVersion(date) === version;
}

// The guard's clock. MIGRATION_GUARD_NOW (ISO 8601) fixes it for tests.
export function guardNow(): number {
  const fixed = process.env.MIGRATION_GUARD_NOW;
  if (fixed === undefined) return Date.now();
  const time = Date.parse(fixed);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(fixed) || !Number.isFinite(time))
    throw new Error(`MIGRATION_GUARD_NOW must be a UTC ISO 8601 timestamp: ${fixed}`);
  return time;
}
