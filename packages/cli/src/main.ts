#!/usr/bin/env bun
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
