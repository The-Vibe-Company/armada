#!/usr/bin/env bun
import { run } from "./run.ts";
import { printSkillHint } from "./skill-hint.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

printSkillHint(process.argv.slice(2), process.exitCode ?? 0, {
  stdout: Boolean(process.stdout.isTTY),
  stderr: Boolean(process.stderr.isTTY),
});
