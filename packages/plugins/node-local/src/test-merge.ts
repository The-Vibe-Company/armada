import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import type { TestMergeRequest, TestMergeResult } from "@armada/plugin-api";

class CommandFailure extends Error {
  readonly output: string;
  readonly exited: boolean;
  constructor(output: string, exited: boolean) {
    super("local command failed");
    this.output = output;
    this.exited = exited;
  }
}

// Keep a Windows tree leader alive until taskkill has terminated the entire tree.
// Otherwise a shell that exits first can leave descendants holding our output pipes.
const windowsRunner = `
const { spawn } = require("node:child_process");
setInterval(() => {}, 60000);
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
child.once("error", () => process.send({ code: null }));
child.once("exit", (code) => process.send({ code }));
`;

/** Copied from V1 cli/src/merge.ts LocalRepo.testMerge: isolated from the worker and owner's checkout. */
export async function testMerge(request: TestMergeRequest): Promise<TestMergeResult> {
  if (!/^[0-9a-f]{40}$/.test(request.base) || !/^[0-9a-f]{40}$/.test(request.head) || !request.commands.length)
    throw new Error("invalid test merge request");
  request.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "armada-merge-"));
  const path = join(directory, "worktree");
  let cleanupSafe = true;
  const run = (
    file: string,
    args: string[],
    cwd = request.repository,
    signal: AbortSignal | null | undefined = request.signal,
  ) =>
    new Promise<{ output: string; truncated: boolean }>((resolve, reject) => {
      signal?.throwIfAborted();
      const windows = process.platform === "win32";
      const child = spawn(windows ? process.execPath : file, windows ? ["-e", windowsRunner, file, ...args] : args, {
        cwd,
        detached: !windows,
        stdio: windows ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = Buffer.alloc(0);
      let truncated = false;
      const capture = (chunk: Buffer) => {
        truncated ||= output.length + chunk.length > 64 * 1024;
        output = Buffer.concat([output, chunk]).subarray(-64 * 1024);
      };
      const text = () => {
        // Drop an incomplete leading UTF-8 code point without expanding it to replacement bytes.
        let start = 0;
        while (start < output.length && ((output[start] ?? 0) & 0xc0) === 0x80) start++;
        return output.subarray(start).toString("utf8");
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      let stopped = false;
      let commandCode: number | null = null;
      let killed: Promise<boolean> | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        if (killed) return killed;
        if (!child.pid) return Promise.resolve(true);
        if (windows) {
          const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
          killed = new Promise<boolean>((done) => {
            if (!win32.isAbsolute(root)) return done(false);
            execFile(
              win32.join(root, "System32", "taskkill.exe"),
              ["/PID", String(child.pid), "/T", "/F"],
              { timeout: 10_000, windowsHide: true },
              (error) => done(!error),
            );
          }).then((confirmed) => {
            if (!confirmed) cleanupSafe = false;
            return confirmed;
          });
          // A failed tree kill or an inherited handle must never leave the caller
          // waiting for close forever. Inconclusive termination is not a gate exit.
          drainTimer = setTimeout(() => {
            cleanupSafe = false;
            stopped = true;
            child.kill("SIGKILL");
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (child.connected) child.disconnect();
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new CommandFailure(text(), false));
          }, 15_000);
          return killed;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
        killed = Promise.resolve(true);
        return killed;
      };
      const abort = () => {
        stopped = true;
        kill();
      };
      const timer = setTimeout(abort, 15 * 60_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (windows)
        child.on("message", (message) => {
          if (message && typeof message === "object" && "code" in message) {
            commandCode = typeof message.code === "number" ? message.code : null;
            void kill();
          }
        });
      // With piped output a background descendant can keep close pending after the
      // gate exits. Kill its process group at exit, then drain the pipes at close.
      child.once("exit", kill);
      child.once("error", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new CommandFailure(text(), false));
      });
      child.once("close", async (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const confirmed = await kill(); // Gates cannot leave background children in a removed worktree.
        clearTimeout(drainTimer);
        const exitCode = windows ? commandCode : code;
        if (!stopped && confirmed && exitCode === 0) resolve({ output: text(), truncated });
        else reject(new CommandFailure(text(), !stopped && confirmed && exitCode !== null));
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
      // Preserve prerequisites produced by earlier gates, including ignored
      // dependency directories. Only artifacts new to this step are cleaned.
      const prerequisites = await run("git", ["ls-files", "--others", "--directory", "-z"], path).catch(() => null);
      try {
        await run("sh", ["-c", command], path);
      } catch (error) {
        let baseCheck: "passed" | "failed" | "unavailable" = "unavailable";
        if (
          error instanceof CommandFailure &&
          error.exited &&
          !request.signal?.aborted &&
          prerequisites &&
          !prerequisites.truncated
        ) {
          try {
            const exclusions = prerequisites.output
              .split("\0")
              .filter(Boolean)
              .flatMap((path) => ["-e", `/${path.replace(/[\\*?[\]!]/g, "\\$&")}`]);
            // Only our private throwaway is reset; tracked head changes and new
            // generated files disappear, while earlier setup remains usable.
            await run("git", ["reset", "--hard", request.base], path);
            await run("git", ["clean", "-ffdx", ...exclusions], path);
            try {
              await run("sh", ["-c", command], path);
              baseCheck = "passed";
            } catch (baseError) {
              if (baseError instanceof CommandFailure && baseError.exited && !request.signal?.aborted)
                baseCheck = "failed";
            }
          } catch {
            // Failed setup, timeout and cancellation are not evidence against the base.
          }
        }
        // Gates can print secrets. Return output transiently; callers persist matched test names only.
        return { ok: false, step, output: error instanceof CommandFailure ? error.output : "", baseCheck };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, step, output: error instanceof CommandFailure ? error.output : "" };
  } finally {
    // Cancellation never prevents cleanup, but unconfirmed Windows descendants
    // quarantine this private worktree rather than deleting beneath a live process.
    if (cleanupSafe) {
      try {
        if (added) await run("git", ["worktree", "remove", "--force", path], request.repository, null);
      } finally {
        if (cleanupSafe) await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
