#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isatty } from "node:tty";
import { run } from "./cli.ts";
import { readCodexModels } from "./codex-models.ts";
import { cliFetch } from "./http.ts";
import type { Exec } from "./io.ts";
import { UsageError } from "./io.ts";
import { echo, emptyLine, feedLine } from "./line.ts";
import { inspectProcess } from "./process.ts";
import { spawnInherited, startBackground } from "./spawn.ts";

function gitBranch(): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000 });
    const branch = r.status === 0 ? r.stdout.trim() : "";
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  let text = "";
  const input = createReadStream("", { fd: 0, autoClose: false, encoding: "utf8" });
  for await (const chunk of input) text += chunk;
  return text;
}

function ghToken(): string | null {
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Reads one line from the terminal in raw mode, so Ctrl-C and Ctrl-D cancel
 * (null) the same way in every prompt. With `hidden`, nothing typed is echoed.
 */
function prompt(question: string, { hidden }: { hidden: boolean }): Promise<string | null> {
  const stdin = process.stdin;
  return new Promise((done) => {
    let line = emptyLine();
    const onData = (chunk: string) => {
      const before = line.answer;
      line = feedLine(line, chunk);
      // Echo before finishing, so a pasted answer ending with Enter is shown too.
      if (!hidden && line.result !== null) process.stderr.write(echo(before, line.answer));
      if (line.result === undefined) return;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      done(line.result);
    };
    // Raw mode first, then the question: nothing typed after the prompt appears can echo.
    stdin.setRawMode(true);
    process.stderr.write(question);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** Opens the browser without a shell; a machine with none (a cloud workspace) just shows the URL. */
function openUrl(url: string): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  // Linux without a display (a server, a container, SSH) has no browser to open.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Runs git or gh without a shell; optional input is piped without a shell. */
const exec: Exec = (command, args, { cwd, timeoutMs, maxOutputBytes, input, env, killTree }) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: killTree,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const kill = () => {
      if (killTree && child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      } else child.kill("SIGKILL");
    };
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
      fail(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ code: oversized ? 1 : (code ?? 1), stdout, stderr, timedOut });
    });
  });

let stopped = false;
if (process.argv.includes("heartbeat") && !process.argv.includes("--background"))
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      stopped = true;
    });

const code = await run(process.argv.slice(2), {
  codexModels: readCodexModels,
  platform: process.platform,
  machineName: hostname(),
  ttyName: process.stdin.isTTY
    ? spawnSync("tty", [], { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] }).stdout?.trim() || null
    : null,
  cwd: process.cwd(),
  env: process.env,
  // Only "not there" means keep searching upward; any other error must surface.
  readFile: (path) =>
    readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    }),
  writeFile: (path, text) => writeFile(path, text, "utf8"),
  stdout: (t) => process.stdout.write(t),
  readBinaryFile: async (path, maxBytes) => {
    const file = await open(path, "r").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    });
    if (!file) return null;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new UsageError("attachment must be a regular image file");
      if (stat.size > maxBytes) throw new UsageError("attachment size limit: images must be at most 2 MB each");
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw new UsageError("attachment size limit: images must be at most 2 MB each");
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  },
  stderr: (t) => process.stderr.write(t),
  ghToken,
  fetch: cliFetch(),
  inspectProcess: (pid) => inspectProcess(exec, pid),
  signalProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
  onSignal: (handler) => {
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const listeners = signals.map((signal) => ({ signal, listener: () => handler(signal) }));
    for (const { signal, listener } of listeners) process.on(signal, listener);
    return () => {
      for (const { signal, listener } of listeners) process.off(signal, listener);
    };
  },
  interactive: isatty(0) && isatty(2),
  prompt,
  gitBranch,
  readStdin,
  exec,
  detach: (command, args, { cwd, env }) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env, stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    }),
  spawn: spawnInherited,
  startBackground,
  stopped: () => stopped,
  backgroundReady: (ready) => {
    if (process.connected) process.send?.({ ready });
  },
  openUrl,
});
process.exitCode = code;
if (process.connected) process.disconnect?.();
