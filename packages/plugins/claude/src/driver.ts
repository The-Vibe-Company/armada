/** A persistent supervised input endpoint. Completed Claude print processes are
 * replaceable turns; the native conversation, worktree and Armada generation stay fixed.
 * Accept input while a turn is active, but queue whole turns so a completed
 * subprocess never takes an acknowledged message with it when it exits.
 */
export const DRIVER = String.raw`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const options = JSON.parse(process.argv[1]);
let child;
let session;
let finishing = false;
let failed = false;
let closed = false;
let completed = 0;
const waiting = [];
const emit = (value) => console.log(JSON.stringify(value));
const failure = () => {
  failed = true;
  emit({ type: "result", is_error: true, result: "Claude CLI turn could not be continued" });
};
function send(line) {
  if (failed) return;
  if (child || finishing) { waiting.push(line); return; }
  if (!child) start();
  if (!child || failed) return;
  child.stdin.write(line + "\n", (error) => { if (error) failure(); });
}
function start() {
  if (completed && !session) { failure(); return; }
  // A resumed print process starts fresh cumulative usage counters.
  if (completed) emit({ type: "armada_turn_start" });
  const cli = spawn(options.command, [...options.args, ...(session ? ["--resume", session] : [])], {
    stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  child = cli;
  let pending = "";
  let result = false;
  let retire;
  let kill;
  let retired = false;
  const event = (line) => {
    try {
      const value = JSON.parse(line);
      if (typeof value.session_id === "string" && value.session_id) session = value.session_id;
      if (value.type === "result") {
        result = true;
        completed++;
        finishing = true;
        cli.stdin.end();
        // Some print CLIs retain an idle process after their final result and EOF.
        // Retire only this completed subprocess; the supervisor's group pin stays alive.
        if (!retire) retire = setTimeout(() => {
          retired = true;
          cli.kill("SIGTERM");
          kill = setTimeout(() => cli.kill("SIGKILL"), 1000);
        }, 1000);
      }
      emit(value);
      if (value.type === "result") emit({ type: "armada_turn_state", completed });
    } catch { /* Non-JSON diagnostics cannot prove a completed turn. */ }
  };
  cli.stdout.setEncoding("utf8");
  cli.stdout.on("data", (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? "";
    if (pending.length > 1048576) { pending = ""; failure(); }
    for (const line of lines) event(line);
  });
  // Diagnostics stay available to the host's masked transcript/watchdog.
  cli.stderr.pipe(process.stderr);
  cli.stdin.on("error", () => { if (!result) failure(); });
  cli.once("error", failure);
  cli.once("close", (code) => {
    if (pending) event(pending);
    clearTimeout(retire);
    clearTimeout(kill);
    child = undefined;
    finishing = false;
    if ((!retired && code !== 0) || !result) failure();
    if (failed) { process.exitCode = 1; input.close(); return; }
    for (const line of waiting.splice(0)) send(line);
    if (closed && !child) process.exit(0);
  });
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  try {
    const value = JSON.parse(line);
    if (value.type !== "user" || value.message?.role !== "user") throw new Error();
    send(line);
  } catch { failure(); }
});
input.on("close", () => {
  closed = true;
  if (child) child.stdin.end();
  else process.exit(failed ? 1 : 0);
});
`;
