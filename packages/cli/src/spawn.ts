// The command `armada run` runs (THE-859): its own standard input and output,
// the environment it is given, and its exit code passed on. Signals the
// terminal sends (Ctrl-C) reach it directly, as one process group; Armada
// waits for it to exit rather than leave it behind.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Exec, Io, Spawn } from "./io.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const spawnInherited: Spawn = (command, args, { cwd, env }) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
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
    child.on("exit", (code, signal) => {
      stop();
      done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });

export const startBackground: NonNullable<Io["startBackground"]> = (args) =>
  new Promise((resolve) => {
    if (process.platform === "win32") return resolve(false);
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, ...args], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
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
  (command, args, { cwd, timeoutMs, maxOutputBytes, input, env, processGroup, signal }) =>
    new Promise((done, fail) => {
      signal?.throwIfAborted();
      const grouped = processGroup === true && process.platform !== "win32";
      const child = (deps.spawn ?? spawn)(command, args, {
        cwd,
        env,
        detached: grouped,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const kill = () => {
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
      let oversized = false;
      const accept = (text: string) => {
        bytes += Buffer.byteLength(text);
        if (maxOutputBytes !== undefined && bytes > maxOutputBytes) {
          oversized = true;
          stdout = stderr = "";
          kill();
        }
        return !oversized;
      };
      child.stdout?.setEncoding("utf8").on("data", (d: string) => {
        if (accept(d)) stdout += d;
      });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => {
        if (accept(d)) stderr += d;
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fail(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        done({ code: oversized ? 1 : (code ?? 1), stdout, stderr, timedOut, outputExceeded: oversized });
      });
    });
