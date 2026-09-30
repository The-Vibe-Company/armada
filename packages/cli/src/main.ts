#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { run } from "./cli.ts";
import { emptyHiddenLine, feedHidden } from "./hidden.ts";

function ghToken(): string | null {
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** Reads one line from the terminal; with `hidden`, nothing typed is echoed. Null on Ctrl-C or Ctrl-D. */
async function prompt(question: string, { hidden }: { hidden: boolean }): Promise<string | null> {
  const stdin = process.stdin;
  if (!hidden) {
    const rl = createInterface({ input: stdin, output: process.stderr, terminal: true });
    let cancelled = false;
    rl.on("SIGINT", () => {
      cancelled = true;
      rl.close();
    });
    try {
      return await rl.question(question);
    } catch {
      return null;
    } finally {
      if (!cancelled) rl.close();
    }
  }
  return new Promise((done) => {
    let line = emptyHiddenLine();
    const onData = (chunk: string) => {
      line = feedHidden(line, chunk);
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
});
process.exit(code);
