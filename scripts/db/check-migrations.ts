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

function suggestedVersion(latest: string): string | undefined {
  const iso = latest.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
  const afterLatest = Date.parse(iso) + 1000;
  if (!Number.isFinite(afterLatest)) return undefined;
  const next = new Date(Math.max(Date.now(), afterLatest));
  if (next.getUTCSeconds() === 0) next.setUTCSeconds(1);
  return next.toISOString().slice(0, 19).replace(/\D/g, "");
}

try {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: bun scripts/db/check-migrations.ts <base-ref> [head-ref]");
  const head = migrations(process.argv[3] ?? "HEAD");
  const baseline = migrations(base);
  const errors: string[] = [];
  const versions = new Map<string, string>();
  const latest = [...baseline.values()].sort().at(-1);
  const rounded: string[] = [];
  for (const [path, version] of head) {
    const previous = versions.get(version);
    if (previous) errors.push(`Duplicate migration version ${version}: ${previous}, ${path}`);
    versions.set(version, path);
    if (baseline.has(path)) continue;
    if (version.endsWith("00")) rounded.push(path);
    if (latest && version <= latest) {
      errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
    }
  }
  if (rounded.length) {
    const highest = [...baseline.values(), ...head.values()].sort().at(-1)!;
    const suggestion = suggestedVersion(highest);
    for (const path of rounded) {
      errors.push(`New migration ${path} has a minute-rounded version. Use UTC seconds other than 00.`);
    }
    if (suggestion) errors.push(`Use migration version ${suggestion} for the first rename, then rerun the guard.`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
