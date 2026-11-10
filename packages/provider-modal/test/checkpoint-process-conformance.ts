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
import { captureProcessBaseline, quiesceSandboxProcesses } from "../src/process-scope.ts";

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
      if (ready.size === 2) process.stdout.write(`${JSON.stringify({ ready: true, codex: child.pid })}\n`);
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
  let dropKill = false;
  const sdk = {
    exec: async (argv: string[]) => {
      // Use the already-built local Bun rather than requiring an installed Modal image.
      const args = argv.map((arg) => (arg === "/opt/armada/runtime-bun/bun" ? bun : arg));
      const child = Bun.spawn(dropKill ? ["setpriv", "--bounding-set=-kill", ...args] : args, {
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
        stdout: { readText: () => new Response(child.stdout).text() },
        wait: () => child.exited,
      };
    },
  } as unknown as Sandbox;
  const machine = { physicalId: "fixture", generation: 1, phase: "booting" } as Machine;
  machine.processBaseline = await captureProcessBaseline(sdk, machine);
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
    if (JSON.parse(frame.slice(0, frame.indexOf("\n"))).ready !== true) throw Error("Both real MCP servers must start");
  } finally {
    clearTimeout(deadline);
  }
  // Without CAP_SYS_PTRACE, dropping CAP_KILL can also deny reading another
  // process's namespace. That must fail closed before it attempts any signals.
  const canInspect =
    (await Bun.spawn(["setpriv", "--bounding-set=-kill", "readlink", "/proc/1/ns/pid"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited) === 0;
  dropKill = true;
  try {
    await quiesceSandboxProcesses(sdk, machine);
    throw Error("Missing CAP_KILL unexpectedly accepted");
  } catch (error) {
    const details = (error as { details?: { processCategory?: string; processFailure?: string } }).details;
    if (
      details?.processCategory !== (canInspect ? "runtime_or_mcp" : "unknown") ||
      details.processFailure !== (canInspect ? "pidfd_signal" : "unproven")
    )
      throw error;
  }
  dropKill = false;
  await quiesceSandboxProcesses(sdk, machine);
  await parent.exited;
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
  if (live.length) throw Error("Managed process survived quiescence");
  writeFileSync(
    "/dev/stdout",
    "PASS: real launcher, Codex and two MCP servers gone; restricted signal failure classified\n",
  );
}
