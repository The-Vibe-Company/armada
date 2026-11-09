import { posix } from "node:path";
import type { ExecRequest, ExecResult } from "@armada/core";
import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";

/** A private one-command supervisor, NOT an HTTP privileged API. Command contents use stdin.
 * Child env is public/credential-free; timeout and retained output are scoped to this command. */
const supervisor = String.raw`
import {spawn} from "node:child_process";
const r=JSON.parse(await Bun.stdin.text());
const child=spawn('/bin/bash',['-s'],{cwd:r.cwd,env:{HOME:'/home/user',PATH:'/usr/local/bin:/usr/bin:/bin',GIT_TERMINAL_PROMPT:'0'},detached:true,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='',truncated=false,timedOut=false;
function collect(kind,chunk){const text=chunk.toString();if(kind==='stdout'){if(stdout.length+text.length>65536)truncated=true;stdout=(stdout+text).slice(0,65536);}else{if(stderr.length+text.length>65536)truncated=true;stderr=(stderr+text).slice(0,65536);}}
child.stdout.on('data',x=>collect('stdout',x));child.stderr.on('data',x=>collect('stderr',x));
child.stdin.on('error',()=>{});child.stdin.end(r.command);
child.once('error',()=>{process.stderr.write('golden_exec_start_failed\n');process.exitCode=1;});
const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},r.timeoutMs);
child.once('close',exitCode=>{clearTimeout(timer);process.stdout.write(JSON.stringify({detached:false,exitCode,stdout,stderr,timedOut,truncated}));});
`;
export async function executeGoldenCommand(sandbox: Sandbox, request: ExecRequest): Promise<ExecResult> {
  const timeout = request.timeoutSeconds ?? 60,
    cwd = request.cwd ?? "/home/user";
  if (request.detached) throw refusal("invalid_request", "Detached golden root commands are not supported.");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
    throw refusal("invalid_request", "Golden command timeout must be 1–600 seconds.");
  if (
    typeof request.command !== "string" ||
    !request.command.length ||
    Buffer.byteLength(request.command) > 1024 * 1024 ||
    !posix.isAbsolute(cwd) ||
    posix.normalize(cwd) !== cwd ||
    Buffer.byteLength(cwd) > 4095 ||
    Array.from(cwd).some((x) => x.charCodeAt(0) < 32 || x.charCodeAt(0) === 127)
  )
    throw refusal("invalid_request", "Invalid golden command or workdir.");
  const process = await sandbox.exec(
    [
      "/usr/bin/env",
      "-i",
      "HOME=/home/user",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/opt/armada/runtime-bun/bun",
      "-e",
      supervisor,
    ],
    { mode: "text", workdir: cwd, env: {}, secrets: [], timeoutMs: (timeout + 5) * 1000, stderr: "ignore" },
  );
  // Drain while writing/waiting so neither child stream can backpressure a long scanner/build.
  const output = process.stdout.readText();
  await process.stdin.writeText(JSON.stringify({ command: request.command, cwd, timeoutMs: timeout * 1000 }));
  await process.stdin.close();
  const [status, body] = await Promise.all([process.wait(), output]);
  if (status !== 0 || Buffer.byteLength(body) > 1024 * 1024)
    throw refusal("unavailable", "Golden root command supervision failed; command outcome is not reported as success.");
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    throw refusal("unavailable", "Invalid golden command result.");
  }
  const r = result as {
    detached?: unknown;
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    timedOut?: unknown;
    truncated?: unknown;
  };
  if (
    r?.detached !== false ||
    (r.exitCode !== null && !Number.isInteger(r.exitCode)) ||
    typeof r.stdout !== "string" ||
    typeof r.stderr !== "string" ||
    r.stdout.length > 65536 ||
    r.stderr.length > 65536 ||
    typeof r.timedOut !== "boolean" ||
    typeof r.truncated !== "boolean"
  )
    throw refusal("unavailable", "Invalid golden command result.");
  return r as ExecResult;
}
