import { readFileSync } from "node:fs";

const versionPattern = /^\d{14}$/;

/** Only a complete release prefix plus known, strictly later main migrations is safe. */
export function stagingMigrationDecision(local: string[], remote: string[], main: string[]): "apply" | "skip" {
  for (const versions of [local, remote, main]) {
    if (versions.some((v) => !versionPattern.test(v)) || new Set(versions).size !== versions.length)
      throw new Error("Invalid or duplicate migration version");
  }
  const extras = remote.filter((v) => !local.includes(v));
  if (!extras.length) return "apply";
  const newest = [...local].sort().at(-1);
  const remoteNewest = [...remote].sort().at(-1)!;
  if (
    !newest ||
    local.some((v) => !remote.includes(v)) ||
    extras.some((v) => v <= newest || !main.includes(v)) ||
    main.some((v) => v > newest && v <= remoteNewest && !remote.includes(v))
  )
    throw new Error("Staging migration history is not a known forward-only extension of this release");
  return "skip";
}

/** Parse the pinned Supabase CLI's migration-list table; unexpected formats fail closed. */
export function parseMigrationHistory(table: string): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  let header = false;
  let separator = false;
  for (const line of table.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*Local\s*\|\s*Remote\s*\|\s*Time \(UTC\)\s*$/.test(line)) {
      if (header) throw new Error("Duplicate migration history header");
      header = true;
      continue;
    }
    if (header && !separator && /^\s*[-+|]+\s*$/.test(line)) {
      separator = true;
      continue;
    }
    const row = line.match(/^\s*(\d{14})?\s*\|\s*(\d{14})?\s*\|[^|]*$/);
    if (!header || !separator || !row || (!row[1] && !row[2])) throw new Error("Unrecognized migration history output");
    if (row[1]) local.push(row[1]);
    if (row[2]) remote.push(row[2]);
  }
  if (!header || !separator) throw new Error("Missing migration history table");
  return { local, remote };
}

if (import.meta.main) {
  const [historyFile, mainFile] = process.argv.slice(2);
  if (!historyFile || !mainFile) throw new Error("Expected history and main migration inventory files");
  const { local, remote } = parseMigrationHistory(readFileSync(historyFile, "utf8"));
  const main = readFileSync(mainFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((path) => {
      const match = path.match(/^supabase\/migrations\/(\d{14})_[^/]+\.sql$/);
      if (!match?.[1]) throw new Error("Invalid main migration filename");
      return match[1];
    });
  console.log(stagingMigrationDecision(local, remote, main));
}
