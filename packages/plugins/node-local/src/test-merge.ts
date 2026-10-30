import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestMergeRequest, TestMergeResult } from "@armada/plugin-api";

/** Copied from V1 cli/src/merge.ts LocalRepo.testMerge: isolated from the worker and owner's checkout. */
export async function testMerge(request: TestMergeRequest): Promise<TestMergeResult> {
  if (!/^[0-9a-f]{40}$/.test(request.base) || !/^[0-9a-f]{40}$/.test(request.head) || !request.commands.length)
    throw new Error("invalid test merge request");
  request.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "armada-merge-"));
  const path = join(directory, "worktree");
  const run = (
    file: string,
    args: string[],
    cwd = request.repository,
    signal: AbortSignal | null | undefined = request.signal,
  ) =>
    new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(file, args, { cwd, detached: process.platform !== "win32", stdio: "ignore" });
      let stopped = false;
      const kill = () => {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      };
      const abort = () => {
        stopped = true;
        kill();
      };
      const timer = setTimeout(abort, 15 * 60_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        kill(); // Gates cannot leave background children writing into a removed worktree.
        if (!stopped && code === 0) resolve();
        else reject(new Error("local command failed"));
      });
    });
  let added = false;
  let step = "git fetch";
  try {
    // Fetch exact objects; no branch refs or working checkout move.
    for (const revision of [request.base, request.head]) {
      try {
        await run("git", ["cat-file", "-e", `${revision}^{commit}`]);
      } catch {
        await run("git", ["fetch", "--no-tags", "origin", revision]);
      }
    }
    step = "git worktree add";
    await run("git", ["worktree", "add", "--detach", path, request.base]);
    added = true;
    step = `git merge ${request.head.slice(0, 7)}`;
    await run(
      "git",
      [
        "-c",
        "user.name=Armada",
        "-c",
        "user.email=armada@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--no-ff",
        "--no-edit",
        request.head,
      ],
      path,
    );
    for (const command of request.commands) {
      step = command;
      await run("sh", ["-c", command], path);
    }
    return { ok: true };
  } catch {
    // Gates can print secrets. Persist only the failed step, never subprocess output.
    return { ok: false, step, output: "The local merge or gate failed; inspect it locally." };
  } finally {
    // Abort never prevents cleanup. --force is safe only for our fresh private worktree.
    try {
      if (added) await run("git", ["worktree", "remove", "--force", path], request.repository, null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
