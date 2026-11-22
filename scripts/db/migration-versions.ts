import { execFileSync } from "node:child_process";

export const FUTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function migrations(ref: string) {
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

export function formatVersion(date: Date) {
  return date.toISOString().split(".")[0]!.replace(/\D/g, "");
}

export function versionDate(version: string) {
  return new Date(version.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z"));
}

export function isValidVersion(version: string) {
  const date = versionDate(version);
  return Number.isFinite(date.getTime()) && formatVersion(date) === version;
}

export function guardNow() {
  const fixed = process.env.MIGRATION_GUARD_NOW;
  if (fixed === undefined) return Date.now();
  const time = Date.parse(fixed);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(fixed) || !Number.isFinite(time))
    throw new Error(`MIGRATION_GUARD_NOW must be a UTC ISO 8601 timestamp: ${fixed}`);
  return time;
}
