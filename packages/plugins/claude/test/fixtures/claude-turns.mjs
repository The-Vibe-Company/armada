#!/usr/bin/env node
// A scripted Claude print CLI for the driver's retire rules (THE-2266). Each scenario
// prints the frames the real CLI printed in the recorded probes, then lingers like a CLI
// that keeps an idle process, so only the driver can end it.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const scenario = process.env.FIXTURE_SCENARIO;
const later = Number(process.env.FIXTURE_LATER_MS ?? 2500);
const say = (value) => console.log(JSON.stringify({ session_id: "turns-session", ...value }));
const ledger = (entry) =>
  process.env.FIXTURE_LEDGER &&
  appendFileSync(process.env.FIXTURE_LEDGER, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const task = { task_id: "b1", task_type: "local_bash", description: "bun run verify" };
let line = 0;
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (raw) => {
  const input = JSON.parse(raw).message.content;
  ledger({ input, resume: process.argv.includes("--resume") });
  line++;
  if (scenario === "background" && line === 1) {
    say({ type: "system", subtype: "init" });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [task] });
    say({ type: "result", num_turns: 2, result: "waiting for verify" });
    setTimeout(() => {
      say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      say({ type: "system", subtype: "init" });
      say({ type: "result", num_turns: 1, result: "verify finished" });
    }, later);
  } else if (scenario === "background") {
    say({ type: "system", subtype: "init" });
    say({ type: "result", num_turns: 1, result: `held:${input}` });
  } else if (scenario === "stale-result") {
    // A resumed session answers a stale task notification first, then runs the real turn.
    say({ type: "system", subtype: "task_notification", status: "stopped" });
    say({ type: "system", subtype: "init" });
    say({ type: "result", num_turns: 0, stop_reason: null, result: "" });
    setTimeout(() => {
      say({ type: "system", subtype: "init" });
      say({ type: "system", subtype: "thinking_tokens" });
      setTimeout(() => say({ type: "result", num_turns: 1, result: `real:${input}` }), later);
    }, 20);
  } else {
    say({ type: "system", subtype: "init" });
    say({ type: "result", num_turns: 1, result: `done:${input}` });
  }
});
