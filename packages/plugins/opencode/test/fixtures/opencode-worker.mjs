#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "list") {
  console.log(`\u001b[90m└  ${process.env.FAKE_AUTH === "yes" ? 1 : 0} credentials\u001b[0m`);
  process.exit(0);
}
if (process.env.FAKE_RUN_MARKER) writeFileSync(process.env.FAKE_RUN_MARKER, "started");
if (args[0] !== "run" || args[args.indexOf("--format") + 1] !== "json") process.exit(2);
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
const emit = (value) => console.log(JSON.stringify({ sessionID: "session-fixture-1", ...value }));
emit({ type: "step_start" });
if (input === "permission-denied") emit({ type: "error", error: { name: "PermissionDeniedError", data: { message: "Runtime requested permissions for tool use; private diagnostic" } } });
else if (input === "fail") emit({ type: "error", error: { name: "APIError", data: { message: "fixture turn failed" } } });
else {
  emit({ type: "text", part: { type: "text", text: JSON.stringify({ input, args, permission: process.env.OPENCODE_PERMISSION ? JSON.parse(process.env.OPENCODE_PERMISSION) : null }) } });
  emit({ type: "step_finish", part: { reason: "stop" } });
}
