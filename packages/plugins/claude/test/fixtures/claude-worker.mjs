#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[args.indexOf("--permission-mode") + 1] !== "bypassPermissions") process.exit(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line).message.content;
  if (process.env.FIXTURE_LEDGER) appendFileSync(process.env.FIXTURE_LEDGER, JSON.stringify({ input, args, cwd: process.cwd() }) + "\n");
  console.log(JSON.stringify({ type: "result", session_id: "claude-fixture-session", modelUsage: { oak: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, result: JSON.stringify({ input, args, cwd: process.cwd() }) }));
  if (process.env.FIXTURE_EXIT_AFTER_RESULT === "exit") process.exit(0);
  if (process.env.FIXTURE_EXIT_AFTER_RESULT === "closed-input") {
    process.stdin.destroy();
    setInterval(() => {}, 1000);
  }
});
