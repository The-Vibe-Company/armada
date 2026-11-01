import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function eventually(
  action: () => Promise<boolean>,
  {
    now = () => performance.now(),
    sleep = async (ms: number) => {
      await setTimeout(ms);
    },
    timeoutMs = 3_000,
  }: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const settled = await action();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    if (settled) return;
    await sleep(Math.min(25, remaining));
  }
  throw new Error("condition did not settle");
}

export async function repository(root: string): Promise<string> {
  const path = join(root, "repository");
  await mkdir(path, { recursive: true });
  // Neither the fixture branch nor hooks/ignore rules come from the developer's HOME.
  await execute("git", ["init", "--quiet", "--initial-branch=fixture-base", "--template=", path]);
  const hooks = join(root, "empty-hooks");
  const excludes = join(root, "empty-excludes");
  await mkdir(hooks, { recursive: true });
  await writeFile(excludes, "");
  await execute("git", ["-C", path, "config", "--local", "core.hooksPath", hooks]);
  await execute("git", ["-C", path, "config", "--local", "core.excludesFile", excludes]);
  await execute("git", ["-C", path, "config", "--local", "core.autocrlf", "false"]);
  await mkdir(join(path, ".git", "info"), { recursive: true });
  await writeFile(join(path, ".git", "info", "exclude"), "# Fixture-local excludes\n");
  await writeFile(join(path, "README.md"), "local node fixture\n");
  await execute("git", ["-C", path, "add", "README.md"]);
  await execute("git", [
    "-C",
    path,
    "-c",
    "user.name=Local node test",
    "-c",
    "user.email=local-node@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return path;
}
