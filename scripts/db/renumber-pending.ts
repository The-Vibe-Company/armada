import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { FUTURE_WINDOW_MS, formatVersion, guardNow, migrations, versionDate } from "./migration-versions.ts";

export type MigrationRename = { from: string; to: string };

export function planRenumber(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
  now: number,
): MigrationRename[] {
  for (const path of base.keys()) {
    if (!head.has(path)) throw new Error(`Base migration missing from HEAD: ${path}`);
  }

  const pending = [...head.keys()].filter((path) => !base.has(path)).sort();
  if (pending.length === 0) return [];

  const latest = [...base.values()].sort().at(-1);
  let time = Math.floor(now / 1000) * 1000;
  if (latest) {
    const latestTime = versionDate(latest).getTime();
    if (!Number.isFinite(latestTime)) throw new Error(`Invalid latest base migration version: ${latest}`);
    time = Math.max(time, latestTime + 1000);
  }
  const occupied = new Set(head.values());
  return pending.map((from) => {
    let version = formatVersion(new Date(time));
    while (version.endsWith("00") || occupied.has(version)) {
      time += 1000;
      version = formatVersion(new Date(time));
    }
    if (time > now + FUTURE_WINDOW_MS) {
      throw new Error("No migration version fits above the base maximum and within 24 hours of the UTC clock.");
    }
    time += 1000;
    return { from, to: from.replace(/\/\d{14}_/, `/${version}_`) };
  });
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function findReferences(plan: MigrationRename[], base: ReadonlyMap<string, string>) {
  const names = new Map(plan.map(({ from, to }) => [basename(from), basename(to)]));
  const patterns = [...names.keys()].flatMap((name) => ["-e", name]);
  const result = spawnSync("git", ["grep", "-IlzF", ...patterns, "--"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr}`);

  const escapedNames = [...names.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escapedNames.join("|"), "g");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      if (base.has(path)) throw new Error(`Rewriting a reference would modify base migration: ${path}`);
      const original = readFileSync(path);
      const updated = original.toString("utf8").replace(pattern, (name) => names.get(name)!);
      return { path, original, updated };
    });
}

async function main(args: string[]) {
  const [ref, ...options] = args;
  if (!ref || ref.startsWith("-") || options.length > 1 || (options.length && options[0] !== "--dry-run")) {
    throw new Error("Usage: bun scripts/db/renumber-pending.ts <base-ref> [--dry-run]");
  }
  process.chdir(git("rev-parse", "--show-toplevel").trimEnd());
  if (git("status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Renumbering requires a clean working tree. Commit pending changes first.");
  }

  const baseCommit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  if (git("merge-base", baseCommit, "HEAD").trim() !== baseCommit) {
    throw new Error(`Merge ${ref} into the branch before renumbering so type generation includes its migrations.`);
  }
  const base = migrations(baseCommit);
  const plan = planRenumber(base, migrations("HEAD"), guardNow());
  if (plan.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const { from, to } of plan) {
    if (existsSync(to)) throw new Error(`Migration destination already exists: ${to}`);
    console.log(`${from} -> ${to}`);
  }
  const references = findReferences(plan, base);
  for (const { path } of references) console.log(`Rewrite references in ${path}`);
  if (options.length) return;

  const undo: (() => void)[] = [];
  try {
    // Update references before renaming because a pending SQL file can contain a reference too.
    for (const { path, original, updated } of references) {
      undo.push(() => writeFileSync(path, original));
      writeFileSync(path, updated);
    }
    for (const { from, to } of plan) {
      renameSync(from, to);
      undo.push(() => renameSync(to, from));
    }
    const { generateDatabaseTypes } = await import("./generate.ts");
    const generated = await generateDatabaseTypes();
    const target = "packages/core/src/database.types.ts";
    const original = readFileSync(target);
    undo.push(() => writeFileSync(target, original));
    writeFileSync(target, generated);
    console.log(`Regenerated ${target}. Review and commit the changes before rerunning the migration guard.`);
  } catch (error) {
    const failures = [];
    for (const restore of undo.reverse()) {
      try {
        restore();
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], "Renumbering failed and rollback was incomplete.");
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
