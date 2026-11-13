import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import durations from "./test-durations.json";

export const SHARD_COUNT = 6;
// Measured lint/typecheck/guard work runs once in shard 1, sharing its setup.
const STATIC_CHECK_SECONDS = 30;
const root = fileURLToPath(new URL("../../", import.meta.url));

// Bun's default discovery names; explicit ./ paths below are exact files, not filters.
export function testFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (result.exitCode !== 0) throw new Error("Cannot discover tracked test files");
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => /[._](test|spec)\.(jsx?|tsx?)$/.test(path))
    .sort();
}

export function validatePlan(files: string[], shards: string[][]): void {
  const expected = new Set(files);
  const assigned = shards.flat();
  if (
    shards.length !== SHARD_COUNT ||
    shards.some((shard) => shard.length === 0) ||
    expected.size !== files.length ||
    assigned.length !== files.length ||
    new Set(assigned).size !== assigned.length ||
    assigned.some((file) => !expected.has(file))
  ) {
    throw new Error(`Every test file must occur in exactly one of ${SHARD_COUNT} nonempty shards`);
  }
}

export function planShards(files: string[], weights: Record<string, number>): string[][] {
  const shards: string[][] = Array.from({ length: SHARD_COUNT }, () => []);
  const loads = Array<number>(SHARD_COUNT).fill(0);
  loads[0] = STATIC_CHECK_SECONDS;
  const weight = (path: string) => {
    const value = weights[path] ?? 1;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid test duration: ${path}`);
    return value;
  };
  // Longest-processing-time first. New files participate automatically with a 1s estimate.
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const [position, file] of ordered.entries()) {
    const empty = shards.flatMap((shard, index) => (shard.length === 0 ? [index] : []));
    // Retain nonempty coverage even for small plans where static work dominates.
    const index = ordered.length - position === empty.length ? empty[0]! : loads.indexOf(Math.min(...loads));
    shards[index]!.push(file);
    loads[index] = loads[index]! + weight(file);
  }
  for (const shard of shards) shard.sort();
  validatePlan(files, shards);
  return shards;
}

/** Only database-only suites share a worker. Native/global-mock suites retain process isolation. */
export function workerBatches(files: readonly string[], sources: Record<string, string>): string[][] {
  const sql: string[] = [];
  const isolated: string[][] = [];
  for (const file of files) {
    const source = sources[file] ?? "";
    const databaseOnly =
      /^(packages\/(core|mcp-server)\/test\/)/.test(file) &&
      /\b(migratedDatabase|openMigratedDatabase|rowOnlyDatabase|rowOnlyConnection|runtimeFixture)\s*\(/.test(source) &&
      !/Bun\.(spawn|serve|env)|captureGitHubAuditLogs|mock\.(module|restore)|\b(CodexDriver|ClaudeDriver|OpencodeDriver)\b|globalThis\.|process\.(env|on|once|chdir)|spyOn\(|child_process|test\.concurrent|setSystemTime|Date\.now\s*=/.test(
        source,
      );
    if (databaseOnly) sql.push(file);
    else isolated.push([file]);
  }
  const batches: string[][] = [];
  // Bound memory/lifetime without rebuilding the pristine image for every SQL suite.
  for (let offset = 0; offset < sql.length; offset += 12) batches.push(sql.slice(offset, offset + 12));
  return [...batches, ...isolated];
}

if (import.meta.main) {
  const shards = planShards(testFiles(), durations);
  console.log(
    `Validated ${shards.flat().length} test files, assigned exactly once: ${shards.map((s) => s.length).join(" / ")}`,
  );
  if (process.argv[2] !== "--check") {
    const index = Number(process.argv[2]);
    if (!Number.isInteger(index) || index < 1 || index > SHARD_COUNT)
      throw new Error(`Expected shard 1..${SHARD_COUNT} or --check`);
    let failed = false;
    const files = shards[index - 1]!;
    const sources = Object.fromEntries(files.map((path) => [path, readFileSync(join(root, path), "utf8")]));
    for (const batch of workerBatches(files, sources)) {
      const started = performance.now();
      const child = Bun.spawn([process.execPath, "test", "--no-orphans", ...batch.map((path) => `./${path}`)], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await child.exited;
      if (code !== 0) failed = true;
      const elapsed = ((performance.now() - started) / 1000).toFixed(3);
      if (batch.length === 1) console.log(`Completed ${batch[0]} in ${elapsed}s`);
      else console.log(`Completed SQL worker in ${elapsed}s: ${batch.join(", ")}`);
    }
    process.exit(failed ? 1 : 0);
  }
}
