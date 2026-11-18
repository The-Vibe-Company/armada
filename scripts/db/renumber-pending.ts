import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

  const sortedNames = [...names.keys()].sort((a, b) => b.length - a.length);
  const escapedNames = sortedNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escapedNames.join("|"), "g");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      if (base.has(path)) throw new Error(`Rewriting a reference would modify base migration: ${path}`);
      const original = readFileSync(path);
      if (!isUtf8(original)) throw new Error(`Cannot rewrite a migration reference in a non-UTF-8 file: ${path}`);
      const updated = original.toString("utf8").replace(pattern, (name) => names.get(name)!);
      return { path, original, updated };
    });
}

function assertCleanCheckout() {
  if (git("status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Renumbering requires a clean working tree. Commit pending changes first.");
  }

  if (
    git("ls-files", "-v", "-z")
      .split("\0")
      .some((entry) => /^[Sa-z] /.test(entry))
  ) {
    throw new Error("Renumbering requires a full checkout without skip-worktree or assume-unchanged files.");
  }
}

function assertMigrationInventory(head: ReadonlyMap<string, string>) {
  const migrationDir = "supabase/migrations";
  const files = readdirSync(migrationDir, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".sql"));
  if (
    files.length !== head.size ||
    files.some((entry) => !entry.isFile() || !head.has(`${migrationDir}/${entry.name}`))
  ) {
    throw new Error("Migration files on disk must match HEAD. Check for ignored SQL files or missing migrations.");
  }
}

type ReferenceEdit = ReturnType<typeof findReferences>[number];

async function generatePlannedTypes(
  head: ReadonlyMap<string, string>,
  plan: MigrationRename[],
  references: ReferenceEdit[],
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "armada-renumber-"));
  try {
    const destinations = new Map(plan.map(({ from, to }) => [from, to]));
    const updates = new Map(references.map(({ path, updated }) => [path, updated]));
    for (const path of head.keys()) {
      const destination = join(directory, basename(destinations.get(path) ?? path));
      const updated = updates.get(path);
      if (updated === undefined) copyFileSync(path, destination);
      else writeFileSync(destination, updated);
    }
    const { generateDatabaseTypes } = await import("./generate.ts");
    return await generateDatabaseTypes(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function applyPlan(plan: MigrationRename[], references: ReferenceEdit[], generated: string) {
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

async function main(args: string[]) {
  const [ref, ...options] = args;
  if (!ref || ref.startsWith("-") || options.length > 1 || (options.length && options[0] !== "--dry-run")) {
    throw new Error("Usage: bun scripts/db/renumber-pending.ts <base-ref> [--dry-run]");
  }
  process.chdir(git("rev-parse", "--show-toplevel").trimEnd());
  assertCleanCheckout();
  const baseCommit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const headCommit = git("rev-parse", "HEAD").trim();
  if (git("merge-base", baseCommit, headCommit).trim() !== baseCommit) {
    throw new Error(`Merge ${ref} into the branch before renumbering so type generation includes its migrations.`);
  }
  const base = migrations(baseCommit);
  const head = migrations(headCommit);
  const plan = planRenumber(base, head, guardNow());
  if (plan.length === 0) {
    console.log("No pending migrations.");
    return;
  }
  assertMigrationInventory(head);
  assertDestinationsAvailable(plan);
  for (const { from, to } of plan) console.log(`${from} -> ${to}`);
  const references = findReferences(plan, base);
  for (const { path } of references) console.log(`Rewrite references in ${path}`);
  if (options.length) return;

  const generated = await generatePlannedTypes(head, plan, references);
  const lock = git("rev-parse", "--git-path", "armada-renumber-pending.lock").trimEnd();
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Renumbering is locked at ${lock}. If a previous run was interrupted, check the working tree and remove the lock directory only after confirming no renumber command is running.`,
      { cause: error },
    );
  }
  try {
    assertCleanCheckout();
    if (git("rev-parse", "HEAD").trim() !== headCommit) {
      throw new Error("HEAD changed during type generation. Rerun the command on the intended branch.");
    }
    assertMigrationInventory(head);
    assertDestinationsAvailable(plan);
    applyPlan(plan, references, generated);
  } finally {
    rmdirSync(lock);
  }
}

function assertDestinationsAvailable(plan: MigrationRename[]) {
  for (const { to } of plan) {
    if (existsSync(to)) throw new Error(`Migration destination already exists: ${to}`);
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
