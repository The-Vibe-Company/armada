#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isatty } from "node:tty";
import { run } from "./cli.ts";
import type { Exec } from "./io.ts";
import { echo, emptyLine, feedLine } from "./line.ts";

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

/** Runs git or gh without a shell; stdin is closed so nothing waits for input. */
const exec: Exec = (command, args, { cwd }) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  // Only "not there" means keep searching upward; any other error must surface.
  readFile: (path) =>
    readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    }),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  ghToken,
  interactive: isatty(0) && isatty(2),
  prompt,
  gitBranch,
  readStdin,
  exec,
});
// Exit once stdout is flushed: Node writes to pipes asynchronously on macOS, and
// exiting at once would cut `armada status --json | jq` at 64 KB.
process.stdout.write("", () => process.exit(code));
