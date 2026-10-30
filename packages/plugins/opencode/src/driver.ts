/** Runs on the selected node, without a plugin path or controlling terminal.
 * Only reduced JSON events reach the host; CLI auth output and stderr stay private.
 * Each turn uses the official CLI and resumes its exact session, never --last.
 */
export const DRIVER = String.raw`
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
const options = JSON.parse(process.argv[1]);
let seq = 0;
let completedTurns = 0;
const emit = (kind, fields = {}) => console.log(JSON.stringify({ armada: 1, seq: ++seq, kind, ...fields }));
const auth = await new Promise((resolve) => {
  execFile(options.command, ["auth", "list"], { timeout: 10000, maxBuffer: 65536 }, (error, stdout, stderr) => {
    const output = (stdout + "\n" + stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const counts = [...output.matchAll(/(?:^|\s)(\d+) (?:credentials?|environment variables?)\b/g)];
    resolve(!error && counts.some((match) => Number(match[1]) > 0));
  });
});
if (!auth) { emit("refused"); process.exit(1); }
// A successful ready frame is larger than any completion snapshot. A node whose
// retained tail cannot hold control frames therefore cannot accept a launch.
emit("ready", { protocol: "armada.runtime.json-lines.v1", completed: 0, maximumCounter: Number.MAX_SAFE_INTEGER });
let session;
let failed = false;
let chain = Promise.resolve();
const deliveries = new Map();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  try {
    const { key, message } = JSON.parse(line);
    if (typeof key !== "string" || !key || typeof message !== "string") throw new Error();
    if (deliveries.has(key)) {
      if (deliveries.get(key) !== message) throw new Error();
      return;
    }
    deliveries.set(key, message);
    chain = chain.then(() => turn(message)).catch(() => { failed = true; emit("failure"); emit("done", { completed: ++completedTurns }); });
  } catch { emit("failure"); }
});
input.on("close", () => { chain.finally(() => process.exit(failed ? 1 : 0)); });
async function turn(message) {
  if (failed) throw new Error("CLI session is no longer usable");
  const args = ["run", ...(session ? ["--session", session] : []), ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--variant", options.effort] : []), ...options.extraArgs, "--format", "json"];
  const child = spawn(options.command, args, { stdio: ["pipe", "pipe", "ignore"], shell: false });
  let pending = "";
  let reply = "";
  let completed = false;
  let turnFailed = false;
  const event = (line) => {
    try {
      const value = JSON.parse(line);
      if (typeof value.sessionID === "string") session = value.sessionID;
      if (value.type === "text" && typeof value.part?.text === "string") reply = (reply + value.part.text).slice(-8192);
      if (value.type === "step_finish" && value.part?.reason === "stop") completed = true;
      if (value.type === "error") turnFailed = true;
    } catch { /* CLI progress diagnostics are not JSON events. */ }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? "";
    if (pending.length > 1048576) { turnFailed = true; pending = ""; }
    for (const line of lines) event(line);
  });
  child.stdin.on("error", () => { turnFailed = true; });
  child.stdin.end(message);
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(code));
  });
  if (pending) event(pending);
  if (code !== 0 || turnFailed || !completed || !session) {
    failed = true;
    emit("failure");
  } else emit("reply", { text: reply });
  emit("done", { completed: ++completedTurns });
}
`;
