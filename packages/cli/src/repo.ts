// A repository checkout on disk: the RepoView doctor and init read, the plan
// init writes, and the git and gh calls around them.
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { RepoView, SetupPlan } from "@armada/core";
import type { Exec, Io } from "./io.ts";

const absent = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
};

async function collect(base: string, dir: string, out: { path: string; content: Uint8Array }[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (![".git", "node_modules", "__pycache__"].includes(entry.name)) await collect(base, full, out);
    } else if (entry.isFile())
      out.push({ path: relative(base, full).split(sep).join("/"), content: await readFile(full) });
  }
}

export function fsRepoView(root: string): RepoView {
  return {
    readFile: (path) =>
      readFile(join(root, path), "utf8").catch((err) => {
        if (absent(err)) return null;
        throw err;
      }),
    readLink: (path) =>
      readlink(join(root, path)).catch((err: NodeJS.ErrnoException) => {
        if (absent(err) || err.code === "EINVAL") return null;
        throw err;
      }),
    readFolder: async (path) => {
      const out: { path: string; content: Uint8Array }[] = [];
      try {
        await collect(join(root, path), join(root, path), out);
      } catch (err) {
        if (absent(err)) return null;
        throw err;
      }
      return out;
    },
  };
}

/**
 * Refuses a path that goes through a symbolic link inside the checkout: writing
 * or deleting through it would change what the link points to, possibly
 * outside the checkout.
 */
async function assertNoLinkedParent(root: string, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  for (let k = 1; k <= parts.length; k++) {
    const parent = parts.slice(0, k).join("/");
    if ((await lstat(join(root, parent)).catch(() => null))?.isSymbolicLink())
      throw new CommandError(`${parent} is a link; Armada does not write through it. Replace it with a folder first.`);
  }
}

/** Writes the plan into the checkout at `root`. */
export async function applyPlan(root: string, plan: SetupPlan): Promise<void> {
  for (const path of [...plan.removes, ...plan.writes.map((w) => w.path), ...plan.links.map((l) => l.path)])
    await assertNoLinkedParent(root, path);
  for (const w of plan.writes)
    if ((await lstat(join(root, w.path)).catch(() => null))?.isSymbolicLink())
      throw new CommandError(`${w.path} is a link; Armada does not write through it. Replace it with a file first.`);
  for (const path of plan.removes) await rm(join(root, path), { force: true });
  for (const w of plan.writes) {
    const full = join(root, w.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, w.content);
  }
  for (const l of plan.links) {
    const full = join(root, l.path);
    await mkdir(dirname(full), { recursive: true });
    // Whatever sits there (a copied folder, a wrong link) is replaced by the link.
    if (await lstat(full).catch(() => null)) await rm(full, { recursive: true, force: true });
    await symlink(l.target, full);
  }
}

export class CommandError extends Error {
  override name = "CommandError";
}

export function requireExec(io: Io): Exec {
  if (!io.exec) throw new CommandError("this command needs git and gh, which this environment cannot run");
  return io.exec;
}

/** Runs a command and returns its trimmed stdout; a non-zero exit throws with its stderr. */
export async function sh(exec: Exec, cwd: string, command: string, args: string[]): Promise<string> {
  const r = await exec(command, args, { cwd }).catch((err: unknown) => {
    throw new CommandError(
      `could not run ${command}: ${err instanceof Error ? err.message : String(err)}. Is ${command} installed?`,
    );
  });
  if (r.code !== 0)
    throw new CommandError(`${command} ${args[0] ?? ""} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** Root of the git checkout containing `cwd`, or null outside one. */
export async function gitRoot(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}
