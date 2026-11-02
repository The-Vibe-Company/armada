#!/usr/bin/env node
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[args.indexOf("--permission-mode") + 1] !== "bypassPermissions") process.exit(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line).message.content;
  console.log(JSON.stringify({ type: "result", result: JSON.stringify({ input, args }) }));
});
