import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isNonTestSource,
  nativePathExclusions,
  nativePathPattern,
  providerAdapterExclusions,
  providerBranchPattern,
} from "./architecture-rules";

const migrationPath = /^supabase\/migrations\/[^/]+\.sql$/;
const sqlSources = /\.(?:sql|tsx?)$/;
const statusInsert = /\binsert\s+into\s+(?:public\.)?sandboxes\s*\([^)]*\bstatus\b[^)]*\)/i;
const statusUpsert = /\.from\(["']sandboxes["']\)\s*\.(?:insert|update|upsert)\s*\(\s*\{[^}]*\bstatus\s*:/s;
const updateSet =
  /\bupdate\s+(?:public\.)?([a-z_][a-z_0-9]*)(?:\s+(?:as\s+)?[a-z_][a-z_0-9]*)?\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|[;`]|$)/gi;
const statusAssignment = /(?:^|,)\s*status\s*=/i;
const leaseAssignment = /(?:^|,)\s*(?:[a-z_]*lease_until|lease_expires_at)\s*=\s*(?!null\b)\S/i;

export function countArchitecture(files: ReadonlyMap<string, string>) {
  let nativeReferences = 0;
  let nativeReferenceFiles = 0;
  let providerIdBranchesOutsideAdapters = 0;
  let sandboxStatusWriterFiles = 0;
  let sourceLines = 0;
  const leaseTables = new Set<string>();

  for (const [path, content] of files) {
    const source = isNonTestSource(path);
    if (!source && !migrationPath.test(path)) continue;

    if (source) {
      sourceLines += content === "" ? 0 : content.split("\n").length - Number(content.endsWith("\n"));
      if (path.endsWith(".ts") || path.endsWith(".tsx")) {
        if (!nativePathExclusions.test(path)) {
          const matches = Array.from(content.matchAll(nativePathPattern)).length;
          nativeReferences += matches;
          nativeReferenceFiles += Number(matches > 0);
        }
        if (!providerAdapterExclusions.test(path)) {
          providerIdBranchesOutsideAdapters += Array.from(content.matchAll(providerBranchPattern)).length;
        }
      }
    }

    if (!sqlSources.test(path)) continue;
    let writesStatus = statusInsert.test(content) || statusUpsert.test(content);
    for (const [, table, assignments] of content.matchAll(updateSet)) {
      if (!table || !assignments) continue;
      if (leaseAssignment.test(assignments)) leaseTables.add(table.toLowerCase());
      if (table.toLowerCase() === "sandboxes") {
        writesStatus ||= statusAssignment.test(assignments);
        // The server data layer builds its SET list with a parameterizing setter.
        writesStatus ||= assignments.startsWith("${sets.join(") && /\bset\(["']status["'],/.test(content);
      }
    }
    sandboxStatusWriterFiles += Number(writesStatus);
  }

  return {
    nativeReferences,
    nativeReferenceFiles,
    nonTestSourceLines: sourceLines,
    providerIdBranchesOutsideAdapters,
    sandboxStatusWriterFiles,
    bespokeLeaseClaimImplementations: leaseTables.size,
    leaseClaimTables: [...leaseTables].sort(),
    netSourceLines: sourceLines,
  };
}

export function gitText(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "ignore" });
  if (!result.success) throw new Error("Unable to read Git data for architecture metrics.");
  return result.stdout.toString();
}

export async function readArchitectureTree(root: string): Promise<Map<string, string>> {
  const paths = gitText(root, ["ls-files", "--cached", "-z"])
    .split("\0")
    .filter((path) => isNonTestSource(path) || migrationPath.test(path));
  const files = new Map<string, string>();
  // Read in batches to keep file descriptor use bounded in large checkouts.
  for (let offset = 0; offset < paths.length; offset += 64) {
    await Promise.all(
      paths.slice(offset, offset + 64).map(async (path) => {
        const file = resolve(root, path);
        const info = await lstat(file, { throwIfNoEntry: false });
        if (info?.isFile()) files.set(path, await readFile(file, "utf8"));
      }),
    );
  }
  return files;
}

if (import.meta.main) {
  const root = resolve(Bun.argv[2] ?? ".");
  console.log(JSON.stringify(countArchitecture(await readArchitectureTree(root)), null, 2));
}
