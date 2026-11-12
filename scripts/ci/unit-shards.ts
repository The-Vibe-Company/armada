import { fileURLToPath } from "node:url";
import durations from "./test-durations.json";

export const SHARD_COUNT = 4;
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
    throw new Error("Every test file must occur in exactly one of four nonempty shards");
  }
}

export function planShards(files: string[], weights: Record<string, number>): string[][] {
  const shards: string[][] = Array.from({ length: SHARD_COUNT }, () => []);
  const loads = Array<number>(SHARD_COUNT).fill(0);
  const weight = (path: string) => {
    const value = weights[path] ?? 1;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid test duration: ${path}`);
    return value;
  };
  // Longest-processing-time first. New files participate automatically with a 1s estimate.
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const index = loads.indexOf(Math.min(...loads));
    shards[index]!.push(file);
    loads[index] = loads[index]! + weight(file);
  }
  for (const shard of shards) shard.sort();
  validatePlan(files, shards);
  return shards;
}

if (import.meta.main) {
  const shards = planShards(testFiles(), durations);
  console.log(
    `Validated ${shards.flat().length} test files, assigned exactly once: ${shards.map((s) => s.length).join(" / ")}`,
  );
  if (process.argv[2] !== "--check") {
    const index = Number(process.argv[2]);
    if (!Number.isInteger(index) || index < 1 || index > SHARD_COUNT) throw new Error("Expected shard 1..4 or --check");
    const child = Bun.spawn([process.execPath, "test", ...shards[index - 1]!.map((path) => `./${path}`)], {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await child.exited);
  }
}
