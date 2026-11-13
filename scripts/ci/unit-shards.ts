import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import durations from "./test-durations.json";

export const SHARD_COUNT = 6;
// Measured lint/typecheck/guard work runs once in shard 1, sharing its setup.
const STATIC_CHECK_SECONDS = 24;
type WorkerObservation = { files: string[]; seconds: number };
const workerKey = (files: readonly string[]) => [...files].sort().join(",");
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

export function planShards(
  files: string[],
  weights: Record<string, number>,
  sources: Record<string, string> = {},
  observations: WorkerObservation[] = [],
): string[][] {
  const shards: string[][] = Array.from({ length: SHARD_COUNT }, () => []);
  const loads = Array<number>(SHARD_COUNT).fill(0);
  loads[0] = STATIC_CHECK_SECONDS;
  const measured = new Map(observations.map((worker) => [workerKey(worker.files), worker.seconds]));
  const weight = (batch: string[]) => {
    const observed = measured.get(workerKey(batch));
    const cold = batch.reduce((total, path) => {
      const value = weights[path] ?? 1;
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid test duration: ${path}`);
      return total + value;
    }, 0);
    // Only unobserved cohorts need an estimate. Keep one cold startup per worker.
    const value = observed ?? (batch.length === 1 ? cold : Math.max(0.1, cold - (batch.length - 1) * 1.5));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid worker duration: ${workerKey(batch)}`);
    return value;
  };
  // Schedule workers atomically: regrouping cold files after placement skews loads.
  const ordered = workerBatches(files, sources, observations);
  while (ordered.length < SHARD_COUNT && ordered.some((batch) => batch.length > 1)) {
    const batch = ordered.find((batch) => batch.length > 1)!;
    ordered.push([batch.pop()!]);
  }
  ordered.sort((a, b) => weight(b) - weight(a) || workerKey(a).localeCompare(workerKey(b)));
  for (const [position, batch] of ordered.entries()) {
    const empty = shards.flatMap((shard, index) => (shard.length === 0 ? [index] : []));
    // Retain nonempty coverage even for small plans where static work dominates.
    const index = ordered.length - position === empty.length ? empty[0]! : loads.indexOf(Math.min(...loads));
    shards[index]!.push(...batch);
    loads[index] = loads[index]! + weight(batch);
  }
  for (const shard of shards) shard.sort();
  validatePlan(files, shards);
  return shards;
}

/** Reviewed helpers own per-suite SQL/row cleanup, never global hooks or mocks. */
function shareSqlWorker(file: string, source: string): boolean {
  return (
    /^(packages\/(core|mcp-server)\/test\/)/.test(file) &&
    (/\b(migratedDatabase|openMigratedDatabase|rowOnlyDatabase|rowOnlyConnection)\s*\(/.test(source) ||
      /import\s*\{[^}]*\b(database|harness)\b[^}]*\}\s*from "\.\/support\.ts"/.test(source)) &&
    !/Bun\.(spawn|serve|env)|runtimeFixture|runtime-fixture|\b(Journal|Runner)\b|captureGitHubAuditLogs|mock\.(module|restore)|\b(CodexDriver|ClaudeDriver|OpencodeDriver)\b|globalThis\.|process\.(env|on|once|chdir)|spyOn\(|child_process|test\.concurrent|setSystemTime|Date\.now\s*=/.test(
      source,
    )
  );
}

/** Only database-only suites share a worker. Native/global-mock suites retain process isolation. */
export function workerBatches(
  files: readonly string[],
  sources: Record<string, string>,
  observations: WorkerObservation[] = [],
): string[][] {
  const sql: string[] = [];
  const isolated: string[][] = [];
  for (const file of files) {
    if (shareSqlWorker(file, sources[file] ?? "")) sql.push(file);
    else isolated.push([file]);
  }
  const batches: string[][] = [];
  const remaining = new Set(sql);
  for (const { files: cohort } of observations) {
    // Source changes that require isolation invalidate the whole measured cohort.
    if (cohort.length < 2 || cohort.length > 12 || new Set(cohort).size !== cohort.length) continue;
    if (!cohort.every((file) => remaining.has(file))) continue;
    batches.push([...cohort]);
    for (const file of cohort) remaining.delete(file);
  }
  const unmeasured = [...remaining].sort();
  // Bound memory/lifetime without rebuilding the pristine image for every SQL suite.
  for (let offset = 0; offset < unmeasured.length; offset += 12) batches.push(unmeasured.slice(offset, offset + 12));
  return [...batches, ...isolated];
}

if (import.meta.main) {
  const allFiles = testFiles();
  const sources = Object.fromEntries(allFiles.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const shards = planShards(allFiles, durations.files, sources, durations.workers);
  console.log(
    `Validated ${shards.flat().length} test files, assigned exactly once: ${shards.map((s) => s.length).join(" / ")}`,
  );
  if (process.argv[2] !== "--check") {
    const index = Number(process.argv[2]);
    if (!Number.isInteger(index) || index < 1 || index > SHARD_COUNT)
      throw new Error(`Expected shard 1..${SHARD_COUNT} or --check`);
    let failed = false;
    const files = shards[index - 1]!;
    const batches = workerBatches(files, sources, durations.workers);
    const run = async (batch: string[]) => {
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
    };
    // This existing test rebuilds a repository artifact read by other suites.
    // Keep its write exclusive; new artifact fixtures must use temporary paths.
    const writer = "packages/mcp-server/test/github-boat.test.ts";
    for (const batch of batches.filter((batch) => batch.includes(writer))) await run(batch);
    const parallel = batches.filter((batch) => !batch.includes(writer));
    let next = 0;
    // Two isolated processes fit the measured SQL-worker memory envelope; never
    // fan out every file. This uses runner cores without requesting more jobs.
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < parallel.length) await run(parallel[next++]!);
      }),
    );
    process.exit(failed ? 1 : 0);
  }
}
