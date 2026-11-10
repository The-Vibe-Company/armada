/** Real OS boundary. Run only as PID1 in a disposable namespace:
 * sudo unshare --pid --fork --mount-proc $(which bun) packages/provider-modal/test/checkpoint-process-conformance.ts
 * Requires the native runtime build; never quiesce the worker's namespace. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Sandbox } from "modal";
import type { Machine } from "../src/ports.ts";
import { captureProcessBaseline, quiesceSandboxProcesses, sealProcessBaseline } from "../src/process-scope.ts";
import { prepareFilesystemSnapshot } from "../src/snapshot.ts";

const bun = process.execPath;
const codex = join(import.meta.dir, "../../agent-runtime/dist/codex");
if (process.argv.includes("--parent")) {
  const home = mkdtempSync(join(tmpdir(), "checkpoint-codex-"));
  const mcp = `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const x=JSON.parse(l);if(x.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:x.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}}));});`;
  const servers = ["armada_orchestrator", "armada_fixture"].map(
    (name) => `${name}={command=${JSON.stringify(bun)},args=${JSON.stringify(["-e", mcp])}}`,
  );
  // A local failing endpoint is sufficient: MCP startup precedes model execution.
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response("fixture", { status: 400 }) });
  const child = spawn(
    codex,
    [
      "-c",
      `mcp_servers={${servers.join(",")}}`,
      "-c",
      'model_provider="fixture"',
      "-c",
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${endpoint.port}",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
      "app-server",
    ],
    {
      detached: true,
      stdio: "pipe",
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    },
  );
  type RpcResponse = { result: { thread: { id: string } } };
  const pending = new Map<number, (value: RpcResponse) => void>();
  const ready = new Set<string>();
  let sequence = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (value.id) pending.get(value.id)?.(value);
    if (value.method === "mcpServer/startupStatus/updated" && value.params.status === "ready") {
      ready.add(value.params.name);
      if (ready.size === 2)
        process.stdout.write(`${JSON.stringify({ ready: true, codex: child.pid, runner: process.pid })}\n`);
    }
  });
  const rpc = (method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve) => {
      pending.set(++sequence, resolve);
      child.stdin.write(`${JSON.stringify({ id: sequence, method, params })}\n`);
    });
  await rpc("initialize", { clientInfo: { name: "fixture", version: "1" } });
  child.stdin.write('{"method":"initialized"}\n');
  const thread = await rpc("thread/start", { model: "fixture", cwd: home });
  await rpc("turn/start", { threadId: thread.result.thread.id, input: [{ type: "text", text: "fixture" }] });
  await new Promise(() => {});
} else if (import.meta.main) {
  if (process.pid !== 1 || process.getuid?.() !== 0) throw Error("Disposable root PID namespace required");
  const denyPidfd = !process.argv.includes("--native-pidfds");
  let dropKill = false;
  let restricted = false;
  const fixtureHome = mkdtempSync(join(tmpdir(), "checkpoint-home-"));
  const wrapper = join(fixtureHome, "signal-policy");
  // A persistent root platform exec service exists before admission. Its late
  // root child is not an Armada writer and may ignore in-sandbox signals.
  const platform = Bun.spawn(
    [
      "setpriv",
      "--bounding-set=-sys_ptrace,-net_raw",
      bun,
      "-e",
      `
import {createInterface} from 'node:readline';
import {openSync} from 'node:fs';
import {dlopen,FFIType} from 'bun:ffi';
const libc=dlopen('libc.so.6',{prctl:{args:[FFIType.i32,FFIType.u64,FFIType.u64,FFIType.u64,FFIType.u64],returns:FFIType.i32}});
if(libc.symbols.prctl(36,1,0,0,0)!==0)throw Error('subreaper_unavailable');
const descriptors=[];
createInterface({input:process.stdin}).on('line',async line=>{const request=JSON.parse(line);
if(request.kill){process.kill(request.kill,'SIGKILL');console.log(JSON.stringify({pid:request.kill}));return;}
if(request.writer){descriptors.push(openSync(request.writer,'w'));console.log(JSON.stringify({pid:process.pid}));return;}
if(request.adopted){
 const code="const p=Bun.spawn(['/bin/sleep','600'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});p.unref();console.log(p.pid);process.exit(0);";
 const parent=Bun.spawn([process.execPath,'-e',code],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
 const pid=Number((await new Response(parent.stdout).text()).trim());await parent.exited;
 console.log(JSON.stringify({pid}));return;
}
const child=Bun.spawn(['/bin/sleep','600'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
console.log(JSON.stringify({pid:child.pid}));});
console.log(JSON.stringify({ready:true}));
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH, HOME: fixtureHome } },
  );
  const platformReader = platform.stdout.getReader(),
    platformDecoder = new TextDecoder();
  let platformBuffer = "";
  async function platformFrame(): Promise<{ pid?: number; ready?: boolean }> {
    while (!platformBuffer.includes("\n")) {
      const chunk = await platformReader.read();
      if (chunk.done) throw Error("Platform control fixture exited");
      platformBuffer += platformDecoder.decode(chunk.value, { stream: true });
      if (platformBuffer.length > 4096) throw Error("Invalid control fixture frame");
    }
    const end = platformBuffer.indexOf("\n"),
      line = platformBuffer.slice(0, end);
    platformBuffer = platformBuffer.slice(end + 1);
    return JSON.parse(line);
  }
  if ((await platformFrame()).ready !== true) throw Error("Platform service not ready before baseline");
  async function platformChild(writer?: string, adopted = false, kill?: number): Promise<number> {
    platform.stdin.write(JSON.stringify({ writer, adopted, kill }) + "\n");
    const result = await platformFrame();
    if (!Number.isSafeInteger(result.pid) || !result.pid) throw Error("Invalid platform child identity");
    return result.pid;
  }
  let controlPid = 0,
    writerPid = 0;
  // Real seccomp, not a controller mock. Native mode denies numeric kill, so a
  // silent fallback cannot masquerade as evidence that the pidfd path works.
  const deniedSyscalls = denyPidfd ? ["__NR_pidfd_open", "__NR_pidfd_send_signal"] : ["__NR_kill"];
  async function compilePolicy() {
    const compiler = Bun.spawn(["cc", "-x", "c", "-o", wrapper, "-"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
    });
    compiler.stdin.write(`#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <stddef.h>
#include <unistd.h>
#include <errno.h>
int main(int argc,char **argv){struct sock_filter code[]={
BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
${[controlPid, writerPid]
  .filter(Boolean)
  .map(
    (pid) => `BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_kill,0,3),
BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,${pid},0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO),
BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_pidfd_open,0,3),
BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,${pid},0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),`,
  )
  .join("\n")}
${deniedSyscalls.map((syscall) => `BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,${syscall},0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|${denyPidfd ? "ENOSYS" : "EPERM"}),`).join("\n")}
BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};struct sock_fprog filter={sizeof(code)/sizeof(code[0]),code};
if(argc<2||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&filter))return 125;
execvp(argv[1],argv+1);return 126;}`);
    compiler.stdin.end();
    if ((await compiler.exited) !== 0) throw Error("Seccomp fixture compilation failed");
  }
  let lastInspectionOutput = "";
  const sdk = {
    exec: async (argv: string[]) => {
      // Use the already-built local Bun rather than requiring an installed Modal image.
      let args = argv.map((arg) => (arg === "/opt/armada/runtime-bun/bun" ? bun : arg));
      if (argv[0] === "/usr/bin/env") args[args.length - 1] = args.at(-1)!.replaceAll("/home/user", fixtureHome);
      if (argv[0] === "bash")
        args = args.map((arg) =>
          arg
            .replaceAll("/home/user", fixtureHome)
            .replaceAll("/run/armada-ssh", join(fixtureHome, "run-ssh"))
            .replaceAll("/etc/ssh", join(fixtureHome, "etc-ssh"))
            .replaceAll("/root/.ssh", join(fixtureHome, "root-ssh")),
        );
      if (restricted)
        args = ["setpriv", "--bounding-set=-sys_ptrace,-net_raw" + (dropKill ? ",-kill" : ""), wrapper, ...args];
      const child = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      return {
        stdin: {
          writeText: async (text: string) => {
            child.stdin.write(text);
          },
          close: async () => {
            child.stdin.end();
          },
        },
        stdout: {
          readText: async () => {
            const text = await new Response(child.stdout).text();
            lastInspectionOutput = text;
            return text;
          },
        },
        wait: () => child.exited,
      };
    },
  } as unknown as Sandbox;
  const machine = { physicalId: "fixture", generation: 1, phase: "booting" } as Machine;
  machine.processBaseline = await captureProcessBaseline(sdk, machine);
  if (!machine.processBaseline.processes.some((row) => row.pid === platform.pid))
    throw Error("Platform service missing before initial capture");
  controlPid = await platformChild();
  await compilePolicy();
  const lock = join(mkdtempSync(join(tmpdir(), "checkpoint-launcher-")), "runtime.lock");
  const parent = Bun.spawn(
    ["flock", lock, "runuser", "-u", process.env.SUDO_USER ?? "user", "--", bun, import.meta.path, "--parent"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const reader = parent.stdout.getReader();
  const deadline = setTimeout(() => {
    throw Error("Real MCP startup deadline exceeded");
  }, 30000);
  const decoder = new TextDecoder();
  let frame = "";
  try {
    while (!frame.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("Both real MCP servers must start");
      frame += decoder.decode(chunk.value, { stream: true });
      if (frame.length > 4096) throw Error("Invalid startup frame");
    }
    const ready = JSON.parse(frame.slice(0, frame.indexOf("\n")));
    if (ready.ready !== true || !Number.isSafeInteger(ready.runner)) throw Error("Both real MCP servers must start");
    machine.processBaseline = await sealProcessBaseline(sdk, machine, ready.runner);
    machine.phase = "active";
    try {
      await sealProcessBaseline(sdk, machine, ready.runner);
      throw Error("Controls recaptured after admission");
    } catch (error) {
      if ((error as { code?: string }).code !== "conflict") throw error;
    }
  } finally {
    clearTimeout(deadline);
  }
  // Keep CAP_KILL but remove ptrace and one capability held by PID1: even root
  // cannot read PID1 namespace links. This must not prevent a checkpoint.
  restricted = true;
  const inspectionProbe = await Bun.spawn(
    ["setpriv", "--bounding-set=-sys_ptrace,-net_raw", "readlink", "/proc/1/ns/pid"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  ).exited;
  if (inspectionProbe === 0) throw Error("Namespace-unreadable configuration not established");
  dropKill = true;
  try {
    await quiesceSandboxProcesses(sdk, machine);
    throw Error("Missing CAP_KILL unexpectedly accepted");
  } catch (error) {
    const details = (
      error as { details?: { processCategory?: string; processFailure?: string; processInspection?: string } }
    ).details;
    if (
      details?.processCategory !== "runtime_or_mcp" ||
      details.processFailure !== "pidfd_signal" ||
      details.processInspection !== "kill_EPERM"
    )
      throw error;
  }
  dropKill = false;
  await prepareFilesystemSnapshot(sdk, { ...machine, golden: false });
  if (denyPidfd && !lastInspectionOutput.includes("pidfd_open_ENOSYS"))
    throw Error("Real pidfd denial was not observed");
  // Bootstrap control helpers may remain stopped after their managed child exits.
  const live = (await import("node:fs"))
    .readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .filter((pid) => {
      if (pid === "1") return false;
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        return !["Z", "X"].includes(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] ?? "");
      } catch {
        return false;
      }
    });
  if (live.some((pid) => !machine.processBaseline!.processes.some((control) => String(control.pid) === pid)))
    throw Error("Managed process survived quiescence");
  if (!live.includes(String(platform.pid)) || !live.includes(String(controlPid)))
    throw Error("Platform control processes must survive checkpoint");
  // A real same-session root orphan must not gain control trust when a Linux
  // PR_SET_CHILD_SUBREAPER adopts it after its intermediate parent exits.
  writerPid = await platformChild(undefined, true);
  const raw = readFileSync(`/proc/${writerPid}/stat`, "utf8"),
    parts = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const serviceRaw = readFileSync(`/proc/${platform.pid}/stat`, "utf8"),
    serviceParts = serviceRaw.slice(serviceRaw.lastIndexOf(")") + 2).split(" ");
  if (Number(parts[1]) !== platform.pid || parts[3] !== serviceParts[3])
    throw Error("Actual same-session subreaper adoption not established");
  await compilePolicy();
  try {
    await prepareFilesystemSnapshot(sdk, { ...machine, golden: false });
    throw Error("Adopted root writer was exempted");
  } catch (error) {
    const details = (error as { details?: Record<string, unknown> }).details;
    if (
      details?.processCategory !== "privileged_writer" ||
      details.processRole !== "writer" ||
      details.processUidClass !== "root" ||
      details.processSurvivorCount !== 1
    )
      throw error;
  }
  await platformChild(undefined, false, writerPid);
  // Even an exact baseline control must not retain a managed-state FD.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(fixtureHome, ".armada-runtime"), { recursive: true });
  writerPid = await platformChild(join(fixtureHome, ".armada-runtime", "positive-writer"));
  await compilePolicy();
  try {
    await prepareFilesystemSnapshot(sdk, { ...machine, golden: false });
    throw Error("Root managed writer was exempted");
  } catch (error) {
    const details = (error as { details?: Record<string, unknown> }).details;
    if (
      details?.processCategory !== "runtime_or_mcp" ||
      details.processFailure !== "unproven" ||
      details.processUidClass !== "root" ||
      details.processRole !== "baseline_control" ||
      details.processManagedState !== "managed" ||
      details.processSurvivorCount !== 1 ||
      details.processIsAncestor !== false ||
      details.processIsPid1 !== false ||
      details.processCommClass !== "bun"
    )
      throw error;
  }
  writeFileSync(
    "/dev/stdout",
    `PASS: unreadable PID1 namespaces checkpoint with ${denyPidfd ? "pidfds denied" : "numeric signals denied"}; platform root control survives and root managed writer refuses\n`,
  );
  // PID1 exit tears down the intentionally retained platform controls in this private namespace.
  process.exit(0);
}
