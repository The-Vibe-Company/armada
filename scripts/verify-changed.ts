import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Workspace {
  path: string;
  name: string;
  dependencies: string[];
}

/** Conservative workspace closure: consumers must be tested when a dependency changes. */
export function affectedWorkspaces(changed: string[], workspaces: Workspace[]): string[] {
  const affected = new Set<string>();
  for (const path of changed) {
    if (path.endsWith(".md") || path.startsWith("docs/")) continue;
    const owner = workspaces.find((workspace) => path.startsWith(`${workspace.path}/`));
    if (!owner) return workspaces.map((workspace) => workspace.path).sort();
    affected.add(owner.name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const workspace of workspaces) {
      if (!affected.has(workspace.name) && workspace.dependencies.some((name) => affected.has(name))) {
        affected.add(workspace.name);
        grew = true;
      }
    }
  }
  return workspaces
    .filter((workspace) => affected.has(workspace.name))
    .map((workspace) => workspace.path)
    .sort();
}

async function git(...args: string[]): Promise<string[]> {
  const result = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(result.stdout).text();
  if ((await result.exited) !== 0) throw new Error(`git ${args[0]} failed; fetch the comparison ref first.`);
  return output.split("\0").filter(Boolean);
}

async function testFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "dist"].includes(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await testFiles(path)));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) paths.push(`./${path}`);
  }
  return paths;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--dry-run", "--base"].includes(arg) && args[args.indexOf(arg) - 1] !== "--base"))
    throw new Error("Usage: bun run verify:changed [--base REF] [--dry-run]");
  const baseIndex = args.indexOf("--base");
  const base = baseIndex < 0 ? "origin/main" : args[baseIndex + 1];
  if (!base || base.startsWith("-")) throw new Error("--base requires a Git ref.");
  const mergeBase = (await git("merge-base", base, "HEAD"))[0]?.trim();
  if (!mergeBase) throw new Error(`No merge base with ${base}; fetch it first.`);
  const changed = [
    ...new Set([
      ...(await git("diff", "--name-only", "-z", "--no-renames", mergeBase, "--")),
      ...(await git("ls-files", "--others", "--exclude-standard", "-z")),
    ]),
  ];
  const workspaces: Workspace[] = [];
  for (const root of ["packages", "apps"]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${root}/${entry.name}`;
      const file = Bun.file(`${path}/package.json`);
      if (!(await file.exists())) continue;
      const manifest = await file.json();
      workspaces.push({
        path,
        name: manifest.name,
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.peerDependencies,
          ...manifest.optionalDependencies,
        }),
      });
    }
  }
  const affected = affectedWorkspaces(changed, workspaces);
  // Root/script tests can import any workspace; keep them in every executable-change run.
  const tests = affected.length
    ? [...new Set([...(await testFiles("scripts")), ...(await Promise.all(affected.map(testFiles))).flat()])].sort()
    : [];
  console.log(`Comparison: ${base} (merge base ${mergeBase}); includes staged, unstaged and untracked files.`);
  console.log(`Affected workspaces: ${affected.join(", ") || "none"}`);
  console.log(`Selected ${tests.length} unit test files. Lint and typecheck remain repository-wide.`);
  if (args.includes("--dry-run")) {
    console.log(tests.join("\n"));
    return;
  }
  for (const command of [
    ["bun", "run", "lint"],
    ["bun", "run", "typecheck"],
    ...(tests.length ? [["bun", "test", ...tests]] : []),
  ]) {
    const result = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await result.exited;
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Changed verification failed.");
    process.exitCode = 1;
  });
