#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const rawArgs = process.argv.slice(2);
const execIndex = rawArgs.indexOf("exec");
const args = execIndex > 0 ? rawArgs.slice(execIndex) : rawArgs;
if (args[0] === "login" && args[1] === "status") {
  console.error(process.env.FAKE_AUTH === "yes" ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(process.env.FAKE_AUTH === "yes" ? 0 : 1);
}
// Recorded from codex-cli 0.164.0. Reject flags unsupported by the selected subcommand.
const recorded = JSON.parse(readFileSync(new URL("./codex-help.json", import.meta.url), "utf8"));
const help = args[1] === "resume" ? recorded.resume : recorded.exec;
if (args.includes("--help")) { console.log(help); process.exit(0); }
for (const arg of args) {
  if (arg.startsWith("-") && arg !== "-" && arg !== "--fixture-extra" && !help.includes(arg.split("=")[0])) process.exit(2);
}
if (process.env.FAKE_RUN_MARKER) writeFileSync(process.env.FAKE_RUN_MARKER, "started");
if (args[0] !== "exec" || !args.includes("--json") || args.at(-1) !== "-") process.exit(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_RUN_MARKER) writeFileSync(process.env.FAKE_RUN_MARKER, input);
if (input === "permission-hold") {
  console.error("Runtime requested permissions for tool use; private diagnostic");
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (input === "hold")
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: "thread.started", thread_id: "session-fixture-1" });
if (input === "permission-denied") emit({ type: "turn.failed", error: { message: "Runtime requested permissions for tool use; private diagnostic" } });
else if (input === "fail") emit({ type: "turn.failed", error: { message: "fixture turn failed" } });
else {
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ input, args: rawArgs }) } });
  emit({ type: "turn.completed" });
}
