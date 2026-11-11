import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GoldenError } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import type { Io } from "./run.ts";
import { SKILL_PACKAGE } from "./skill-package.ts";

const SOURCE = "https://github.com/The-Vibe-Company/armada";
const SKILLS = SKILL_PACKAGE.names;
const HELP = `Usage: armada skill install (--project <directory> | --global) --yes [--revision <40-character commit>]
Install the Armada tool-knowledge skill and its references from public GitHub for Codex and Claude Code.
Requires Git, not Armada login or Node 22. Never overwrites existing skill directories.
Project roots: <directory>/.agents/skills and <directory>/.claude/skills.
Global roots: ~/.agents/skills and ~/.claude/skills (native agent defaults).
--yes explicitly approves a noninteractive install; no prompts are ever opened.
Default source: The-Vibe-Company/armada at reviewed commit ${SKILL_PACKAGE.revision}.
`;

async function git(args: string[], cwd: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.on("error", () => reject(new Error("Git is required for public skill installation.")));
    child.on("close", (code) =>
      code === 0
        ? accept(output.trim())
        : reject(new Error("Public GitHub checkout failed; check Git and network access.")),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function safeParents(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await safeParents(parent);
  if (await exists(path)) {
    if (!(await lstat(path)).isDirectory()) throw new Error(`Not a real directory (symlinks refused): ${path}`);
  }
}

async function files(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(full)));
    else if (entry.isFile()) result.push(full);
    else throw new Error("Skill source contains a symlink or special file; installation refused.");
  }
  return result;
}

/** Preflight the complete package set before writing; existing destinations are never updated. */
export async function copySkillPackages(checkout: string, base: string): Promise<string[]> {
  const plans: { source: string; destination: string; entries: string[] }[] = [];
  for (const root of [".agents", ".claude"]) {
    for (const name of SKILLS) {
      const source = join(checkout, SKILL_PACKAGE.sourceDirectory, name);
      await safeParents(source);
      if (!(await readFile(join(source, "SKILL.md"), "utf8")).startsWith("---")) {
        throw new Error(`Missing skill metadata: ${name}`);
      }
      const destination = join(base, root, "skills", name);
      await safeParents(dirname(destination));
      if (await exists(destination))
        throw new Error(`Destination already exists; preserved without changes: ${destination}`);
      plans.push({ source, destination, entries: await files(source) });
    }
  }
  const created: string[] = [];
  try {
    for (const plan of plans) {
      await mkdir(dirname(plan.destination), { recursive: true });
      // Exclusive leaf creation also refuses a destination created after preflight.
      await mkdir(plan.destination);
      created.push(plan.destination);
      for (const entry of plan.entries) {
        const target = join(plan.destination, entry.slice(plan.source.length + 1));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(entry, target, constants.COPYFILE_EXCL);
      }
    }
    return created;
  } catch (error) {
    for (const path of created) await rm(path, { recursive: true, force: true });
    throw error;
  }
}

export async function skillCommand(argv: readonly string[], io: Io): Promise<number> {
  if (argv.includes("--help")) {
    io.out(HELP);
    return 0;
  }
  const args = parseArgs(argv, ["--project", "--revision"], ["--global", "--yes"]);
  const project = single(args, "--project");
  const revision = single(args, "--revision");
  if (
    args.positionals.join(" ") !== "install" ||
    (project !== undefined) === flag(args, "--global") ||
    project === "" ||
    !flag(args, "--yes") ||
    [...args.options.keys()].some((key) => !["--project", "--revision", "--global", "--yes"].includes(key)) ||
    (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision))
  ) {
    throw new GoldenError("invalid_config", HELP);
  }
  const base = resolve(project ?? homedir());
  let temp: string | undefined;
  try {
    await safeParents(base);
    temp = await realpath(await mkdtemp(join(tmpdir(), "armada-skills-")));
    await git(["init", "--quiet"], temp);
    await git(["fetch", "--quiet", "--depth=1", `${SOURCE}.git`, revision ?? SKILL_PACKAGE.revision], temp);
    const commit = await git(["rev-parse", "FETCH_HEAD"], temp);
    if (!/^[a-f0-9]{40}$/.test(commit) || (revision && revision !== commit))
      throw new Error("Source revision verification failed.");
    await git(["checkout", "--quiet", commit, "--", SKILL_PACKAGE.sourceDirectory], temp);
    const destinations = await copySkillPackages(temp, base);
    io.out(`Source: ${SOURCE}/tree/${commit}/.agents/skills\n`);
    for (const destination of destinations) io.out(`Installed: ${destination}\n`);
    return 0;
  } catch (error) {
    io.err(`armada: Skill installation failed: ${error instanceof Error ? error.message : "local I/O error"}\n`);
    return 1;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
