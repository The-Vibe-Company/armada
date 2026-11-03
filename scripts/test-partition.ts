// CI runs the repository's `bun test` as parallel jobs, one partition each (THE-2239);
// `bun run test` still runs everything at once. A test file under no partition would
// run locally and never in CI: `--check` refuses that.
//
//   bun scripts/test-partition.ts <partition>   run `bun test` on the partition's directories
//   bun scripts/test-partition.ts --check       every test file belongs to one partition
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PARTITIONS: Record<string, readonly string[]> = {
  core: ["packages/core", "packages/cli", "e2e"],
  dashboard: ["packages/dashboard"],
  app: ["packages/app", "packages/plugins", "packages/protocol", "packages/plugin-api"],
  daemon: ["packages/daemon", "packages/desktop"],
};

const root = fileURLToPath(new URL("..", import.meta.url));
// Bun's own rule: ".test", "_test_", ".spec" or "_spec_" in a script's name.
const TEST_FILE = /(\.test|_test_|\.spec|_spec_).*\.[cm]?[jt]sx?$/;
const SKIPPED = new Set(["node_modules"]);

function testFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".")) testFiles(join(directory, entry.name), found);
    } else if (TEST_FILE.test(entry.name)) found.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
  }
  return found;
}

function partitionOf(file: string): string[] {
  return Object.entries(PARTITIONS)
    .filter(([, directories]) => directories.some((directory) => file.startsWith(`${directory}/`)))
    .map(([name]) => name);
}

function check(): number {
  const files = testFiles(root);
  const strays = files.filter((file) => partitionOf(file).length !== 1);
  if (strays.length === 0) {
    console.log(`Every test file (${files.length}) belongs to one partition.`);
    return 0;
  }
  for (const file of strays) {
    const owners = partitionOf(file);
    console.error(
      owners.length === 0
        ? `${file} belongs to no partition: add its directory to PARTITIONS in scripts/test-partition.ts`
        : `${file} belongs to several partitions (${owners.join(", ")})`,
    );
  }
  return 1;
}

async function run(name: string): Promise<number> {
  const directories = PARTITIONS[name];
  if (!directories) {
    console.error(`Unknown partition "${name}". Partitions: ${Object.keys(PARTITIONS).join(", ")}`);
    return 2;
  }
  // Bun needs each directory filter as a relative path, and refuses one without tests.
  const withTests = directories.filter((directory) => testFiles(join(root, directory)).length > 0);
  if (withTests.length === 0) {
    console.error(`Partition "${name}" has no test files.`);
    return 1;
  }
  const spawn = (command: string[]) =>
    Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
  // The same preparation as `bun run test`.
  const catalog = await spawn([process.execPath, "run", "plugins:catalog"]);
  if (catalog !== 0) return catalog;
  console.log(`bun test ${withTests.map((directory) => `./${directory}`).join(" ")}`);
  const started = performance.now();
  const code = await spawn([process.execPath, "test", ...withTests.map((directory) => `./${directory}`)]);
  // Per-step evidence against the job's timeout (THE-2239).
  const seconds = Math.round((performance.now() - started) / 1000);
  console.log(
    `Partition "${name}": bun test took ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s (exit ${code}).`,
  );
  return code;
}

if (import.meta.main) {
  const [argument] = process.argv.slice(2);
  if (argument === "--check") process.exit(check());
  if (!argument || argument.startsWith("-")) {
    console.error("Usage: bun scripts/test-partition.ts <partition> | --check");
    process.exit(2);
  }
  process.exit(await run(argument));
}
