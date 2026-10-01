// The command `armada run` runs (THE-859): its own standard input and output,
// the environment it is given, and its exit code passed on. Signals the
// terminal sends (Ctrl-C) reach it directly, as one process group; Armada
// waits for it to exit rather than leave it behind.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Spawn } from "./io.ts";

// Ctrl-C reaches the child from the terminal already: Armada only stays alive for it.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const spawnInherited: Spawn = (command, args, { cwd, env }) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    // A signal sent to Armada alone is passed on; the terminal's Ctrl-C reached the child already.
    const handlers = SIGNALS.map((signal) => {
      const handler = () => {
        if (signal !== "SIGINT") child.kill(signal);
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
