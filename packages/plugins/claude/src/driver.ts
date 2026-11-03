/** A persistent supervised input endpoint. Completed Claude print processes are
 * replaceable turns; the native conversation, worktree and Armada generation stay fixed.
 * Accept input while a turn is active, but queue whole turns so a completed
 * subprocess never takes an acknowledged message with it when it exits.
 *
 * A `result` is not always the end of a process's work (THE-2266):
 * - The CLI lists its live background tasks and subagents in `system/background_tasks_changed`
 *   (the whole set each time). After a `result` with live tasks it keeps running, and starts
 *   a turn of its own when a task ends. Such a process is held: never retired, its input stays
 *   open, and a message delivered meanwhile is written straight to it.
 * - A resumed session can first answer a stale task notification with an empty `result`
 *   (`num_turns: 0`) and then start the real turn. A new turn's first frame cancels a
 *   pending retire, both its SIGTERM and its SIGKILL, before either is sent.
 * Delivered lines count as completed (`armada_turn_state`) only when their process ends, so a
 * held process reads as working and an intermediate result never reads as idle.
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
let results = 0;
let completed = 0;
// Set while the current process may take one more line: its first turn, or a held process.
let accept;
const waiting = [];
// Frames that mean the process is running a turn again after a result.
const turnFrames = new Set(["assistant", "user", "stream_event"]);
const turnSystem = new Set(["init", "thinking_tokens", "turn_starting"]);
const emit = (value) => console.log(JSON.stringify(value));
const failure = () => {
  failed = true;
  emit({ type: "result", is_error: true, result: "Claude CLI turn could not be continued" });
};
function send(line) {
  if (failed) return;
  if (!child && !finishing) start();
  if (!child || failed) return;
  if (accept) accept(line);
  else waiting.push(line);
}
function start() {
  if (results && !session) { failure(); return; }
  // A resumed print process starts fresh cumulative usage counters.
  if (results) emit({ type: "armada_turn_start" });
  const cli = spawn(options.command, [...options.args, ...(session ? ["--resume", session] : [])], {
    stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  child = cli;
  let pending = "";
  let result = false;
  let retire;
  let kill;
  let retired = false;
  let lines = 0;
  let open = true;
  const tasks = new Set();
  const into = (line) => {
    lines++;
    cli.stdin.write(line + "\n", (error) => { if (error) failure(); });
  };
  // One line per turn: later input waits in the driver for this turn's result.
  const once = (line) => { accept = undefined; into(line); };
  accept = once;
  const event = (line) => {
    try {
      const value = JSON.parse(line);
      if (typeof value.session_id === "string" && value.session_id) session = value.session_id;
      if (value.type === "system" && value.subtype === "background_tasks_changed" && Array.isArray(value.tasks)) {
        tasks.clear();
        for (const task of value.tasks) if (typeof task?.task_id === "string") tasks.add(task.task_id);
      } else if (!retired && (turnFrames.has(value.type) || (value.type === "system" && turnSystem.has(value.subtype)))) {
        // Another turn began before the retire fired: neither SIGTERM nor SIGKILL is scheduled now.
        clearTimeout(retire);
        retire = undefined;
      }
      if (value.type === "result") {
        result = true;
        results++;
        if (tasks.size && open) {
          // Held: background work continues in this process, and input reaches it directly.
          if (waiting.length) for (const queued of waiting.splice(0)) into(queued);
          else accept = once;
        } else {
          accept = undefined;
          finishing = true;
          if (open) { open = false; cli.stdin.end(); }
          // Some print CLIs retain an idle process after their final result and EOF.
          // Retire only this completed subprocess; the supervisor's group pin stays alive.
          if (!retire && !retired && !tasks.size) retire = setTimeout(() => {
            retired = true;
            cli.kill("SIGTERM");
            kill = setTimeout(() => cli.kill("SIGKILL"), 1000);
          }, 1000);
        }
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
    accept = undefined;
    finishing = false;
    if ((!retired && code !== 0) || !result) failure();
    // Every line this process took is settled once it ends.
    completed += lines;
    emit({ type: "armada_turn_state", completed });
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
  if (child) { if (!finishing) child.stdin.end(); }
  else process.exit(failed ? 1 : 0);
});
`;
