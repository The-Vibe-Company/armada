import { execFileSync } from "node:child_process";

function migrations(ref: string): Map<string, string> {
	const paths = execFileSync(
		"git",
		["ls-tree", "-r", "--name-only", ref, "--", "supabase/migrations"],
		{ encoding: "utf8" },
	).trim();
	const result = new Map<string, string>();
	for (const path of paths ? paths.split("\n") : []) {
		if (!path.endsWith(".sql")) continue;
		const match = /^supabase\/migrations\/(\d{14})_.+\.sql$/.exec(path);
		if (!match) throw new Error(`Invalid migration filename: ${path}`);
		result.set(path, match[1] as string);
	}
	return result;
}

try {
	const base = process.argv[2];
	if (!base) throw new Error("Usage: bun scripts/db/check-migrations.ts <base-ref> [head-ref]");
	const head = migrations(process.argv[3] ?? "HEAD");
	const baseline = migrations(base);
	const errors: string[] = [];
	const versions = new Map<string, string>();
	const latest = [...baseline.values()].sort().at(-1);
	for (const [path, version] of head) {
		const previous = versions.get(version);
		if (previous) errors.push(`Duplicate migration version ${version}: ${previous}, ${path}`);
		versions.set(version, path);
		if (!baseline.has(path) && latest && version <= latest) {
			errors.push(`New migration ${path} must have a version strictly greater than ${latest} on ${base}`);
		}
	}
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(`Migration versions OK (${head.size} files; base ${base}, latest ${latest ?? "none"})`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
