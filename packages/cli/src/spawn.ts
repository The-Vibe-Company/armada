// The command `armada run` runs (THE-859): its own standard input and output,
// the environment it is given, and its exit code passed on. Signals the
// terminal sends (Ctrl-C) reach it directly, as one process group; Armada
// waits for it to exit rather than leave it behind.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Io, Spawn } from "./io.ts";

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
