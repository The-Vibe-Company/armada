#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { run } from "./cli.ts";
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
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
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
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  prompt,
  gitBranch,
  readStdin,
});
// Exit once stdout is flushed: Node writes to pipes asynchronously on macOS, and
// exiting at once would cut `armada status --json | jq` at 64 KB.
process.stdout.write("", () => process.exit(code));
