import { FUTURE_WINDOW_MS, formatVersion, guardNow, isValidVersion, migrations } from "./migration-versions.ts";

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
      ? ` Start from the current UTC time (date -u +%Y%m%d%H%M%S) when it is above ${latest}; otherwise pick a time well inside the range rather than right after ${latest}, so concurrent authors do not collide.`
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
