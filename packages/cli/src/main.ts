#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { run } from "./cli.ts";

function ghToken(): string | null {
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  ghToken,
});
process.exit(code);
