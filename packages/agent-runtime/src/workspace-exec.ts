import { spawn } from "node:child_process";
import type { ExecResult } from "@armada/core";
import { validateHarnessCwd } from "./cwd.ts";
import type { Journal } from "./journal.ts";
import { groupState, processIdentity } from "./processes.ts";
export interface WorkspaceExec {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  phase: "repository" | "init";
  index: number;
  attempt: number;
}
export function validateWorkspaceExec(input: WorkspaceExec): WorkspaceExec {
  if (
    !input ||
    Object.keys(input).some((k) => !["command", "cwd", "timeoutSeconds", "phase", "index", "attempt"].includes(k)) ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 65536 ||
    input.command.includes("\0") ||
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > 600 ||
    !["repository", "init"].includes(input.phase) ||
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index > 100 ||
    ![0, 1].includes(input.attempt)
  )
    throw Error("workspace_request_invalid");
  return { ...input, cwd: validateHarnessCwd(input.cwd) };
}
/** Launch-only foreground work. No model environment, argv command, detached
 * receipt, unverified PID signaling, or owned group left behind on cancellation. */
export async function executeWorkspace(
  input: WorkspaceExec,
  journal: Journal,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Extract<ExecResult, { detached: false }>> {
  const { cwd } = validateWorkspaceExec(input);
  signal.throwIfAborted();
  const child = spawn("/bin/bash", ["-s"], {
    cwd,
    detached: true,
    env: { ...env, PATH: `/usr/local/bin:${env.PATH ?? "/usr/bin:/bin"}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  let stdout = "",
    stderr = "",
    truncated = false,
    timedOut = false;
  const collect = (channel: "stdout" | "stderr", chunk: Buffer) => {
    const value = (channel === "stdout" ? stdout : stderr) + chunk.toString();
    if (value.length > 65536) truncated = true;
    if (channel === "stdout") stdout = value.slice(0, 65536);
    else stderr = value.slice(0, 65536);
  };
  child.stdout.on("data", (c) => collect("stdout", c));
  child.stderr.on("data", (c) => collect("stderr", c));
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(null));
  });
  let identity: ReturnType<typeof processIdentity>, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    timedOut = true;
    child.stdin.destroy();
    try {
      if (child.pid && identity && groupState(child.pid, identity) === "live") process.kill(-child.pid, "SIGKILL");
      else if (!identity) child.kill("SIGKILL");
    } catch {}
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    identity = processIdentity(child.pid!);
    // Shell still waits on stdin, so no descendants can escape before ownership.
    if (!identity) {
      stop();
      await closed;
      throw Error("workspace_process_identity_unavailable");
    }
    journal.db
      .query("INSERT OR REPLACE INTO processes VALUES(?,?)")
      .run(child.pid!, JSON.stringify({ pid: child.pid, status: "running", identity }));
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, input.timeoutSeconds * 1000);
    if (signal.aborted) stop();
    else child.stdin.end(`set +x\n${input.command}\n`);
    const exitCode = await closed;
    if (groupState(child.pid!, identity) !== "gone") {
      stop();
      throw Error("workspace_writers_remain");
    }
    return {
      detached: false,
      exitCode,
      stdout: journal.redact(stdout),
      stderr: journal.redact(stderr),
      truncated,
      timedOut,
    };
  } catch (error) {
    stop();
    await closed;
    if (error instanceof Error && error.message.startsWith("workspace_")) throw error;
    throw Error("workspace_process_failed");
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (child.pid)
      journal.db
        .query("INSERT OR REPLACE INTO processes VALUES(?,?)")
        .run(child.pid, JSON.stringify({ pid: child.pid, status: "exited", identity }));
  }
}
