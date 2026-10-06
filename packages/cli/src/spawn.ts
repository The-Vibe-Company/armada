// The command `armada run` runs (THE-859): its own standard input and output,
// the environment it is given, and its exit code passed on. Signals the
// terminal sends (Ctrl-C) reach it directly, as one process group; Armada
// waits for it to exit rather than leave it behind.

import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec, Io, Spawn } from "./io.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const spawnInherited: Spawn = (command, args, { cwd, env, output }) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: output ? ["inherit", "pipe", "pipe"] : "inherit" });
    if (output) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", output.stdout);
      child.stderr?.on("data", output.stderr);
    }
    // A signal sent to Armada is passed on, except a terminal's Ctrl-C, which reached the child already.
    const fromTerminal = process.stdin.isTTY === true;
    const handlers = SIGNALS.map((signal) => {
      const handler = () => {
        if (signal !== "SIGINT" || !fromTerminal) child.kill(signal);
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const stop = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      stop();
      fail(err.code === "ENOENT" ? new Error(`${command}: command not found`) : err);
    });
    child.on("close", (code, signal) => {
      stop();
      done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });

export const startBackground: NonNullable<Io["startBackground"]> = (args, options) =>
  new Promise((resolve) => {
    if (process.platform === "win32") return resolve(false);
    let log: number | undefined;
    try {
      if (options?.logPath) {
        mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
        log = openSync(options.logPath, "a", 0o600);
      }
    } catch {
      return resolve(false);
    }
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, ...args], {
      cwd: process.cwd(),
      env: options?.env ?? process.env,
      detached: true,
      stdio: ["ignore", log ?? "ignore", log ?? "ignore", "ipc"],
    });
    if (log !== undefined) closeSync(log);
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!ready) child.kill("SIGTERM");
      if (child.connected) child.disconnect();
      child.unref();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), 20_000);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    child.once("message", (message) =>
      finish(typeof message === "object" && message !== null && "ready" in message && message.ready === true),
    );
  });

/** Runs git or gh without a shell; optional input is piped without a shell. */
export const createExec =
  (deps: { spawn?: typeof spawn; killGroup?: (pid: number) => void } = {}): Exec =>
  (command, args, { cwd, timeoutMs, maxOutputBytes, captureStdout, input, env, processGroup, signal }) =>
    new Promise((done, fail) => {
      signal?.throwIfAborted();
      const grouped = processGroup === true && process.platform !== "win32";
      const limit = maxOutputBytes ?? (captureStdout === "file" ? 2_000_000 : Number.POSITIVE_INFINITY);
      let directory: string | undefined;
      let file: number | undefined;
      const cleanupFile = () => {
        if (file !== undefined) {
          closeSync(file);
          file = undefined;
        }
        if (directory) {
          rmSync(directory, { recursive: true, force: true });
          directory = undefined;
        }
      };
      let child: ReturnType<typeof spawn>;
      try {
        if (captureStdout === "file") {
          directory = mkdtempSync(join(tmpdir(), "armada-exec-"));
          file = openSync(join(directory, "stdout"), "wx+", 0o600);
        }
        child = (deps.spawn ?? spawn)(command, args, {
          cwd,
          env,
          detached: grouped,
          stdio: [input === undefined ? "ignore" : "pipe", file ?? "pipe", "pipe"],
        });
      } catch (error) {
        cleanupFile();
        fail(error);
        return;
      }
      let finished = false;
      const kill = () => {
        if (finished) return;
        if (grouped && child.pid) {
          try {
            (deps.killGroup ?? ((pid) => process.kill(-pid, "SIGKILL")))(child.pid);
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      };
      const abort = () => kill();
      signal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs)
        : null;
      if (input !== undefined) {
        child.stdin?.on("error", () => {}); // An early exit can close stdin before the prompt is written.
        child.stdin?.end(input);
      }
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let fileBytes = 0;
      let oversized = false;
      const checkBound = () => {
        fileBytes = file === undefined ? 0 : fstatSync(file).size;
        if (!oversized && bytes + fileBytes > limit) {
          oversized = true;
          stdout = stderr = "";
          kill();
        }
        return !oversized;
      };
      // Monitor file growth during execution as well as checking its final size.
      const monitor = file !== undefined ? setInterval(checkBound, 25) : null;
      const accept = (text: string) => {
        bytes += Buffer.byteLength(text);
        return checkBound();
      };
      child.stdout?.setEncoding("utf8").on("data", (d: string) => {
        if (accept(d)) stdout += d;
      });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => {
        if (accept(d)) stderr += d;
      });
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (monitor) clearInterval(monitor);
        signal?.removeEventListener("abort", abort);
        cleanupFile();
        fail(err);
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (monitor) clearInterval(monitor);
        signal?.removeEventListener("abort", abort);
        try {
          if (checkBound() && file !== undefined) {
            const buffer = Buffer.alloc(fileBytes);
            let offset = 0;
            while (offset < buffer.length) {
              const read = readSync(file, buffer, offset, buffer.length - offset, offset);
              if (!read) break;
              offset += read;
            }
            stdout = buffer.subarray(0, offset).toString("utf8");
          }
          cleanupFile();
          done({ code: oversized ? 1 : (code ?? 1), stdout, stderr, timedOut, outputExceeded: oversized });
        } catch (error) {
          cleanupFile();
          fail(error);
        }
      });
    });
