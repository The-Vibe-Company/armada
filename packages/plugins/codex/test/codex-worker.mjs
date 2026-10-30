#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  console.error(process.env.FAKE_AUTH === "yes" ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(process.env.FAKE_AUTH === "yes" ? 0 : 1);
}
writeFileSync(process.env.FAKE_RUN_MARKER, "started");
if (args[0] !== "exec" || !args.includes("--json") || args.at(-1) !== "-") process.exit(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.env.FAKE_RUN_MARKER, input);
if (input === "hold")
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: "thread.started", thread_id: "session-fixture-1" });
if (input === "fail") emit({ type: "turn.failed", error: { message: "fixture turn failed" } });
else {
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ input, args }) } });
  emit({ type: "turn.completed" });
}
