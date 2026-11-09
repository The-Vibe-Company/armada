import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeCwdCommand, nativeCwdInstallScript } from "../../provider-boat/src/native-cwd.ts";
import { type McpBootstrap, nativeMcpInstallScript } from "../src/mcp-native.ts";

/** Same bounded privilege fixture as provider-boat/native-cwd: run only the expected sudo
 * shape against this test's owned temporary tree, without requesting host elevation. */
async function installEnvironment(home: string) {
  const bin = join(home, "fixture-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "sudo"),
    `#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = -n ] && [ "$2" = bash ] && [ "$3" = -c ] || exit 97
case "$4" in *"$ARMADA_NATIVE_TEST_ROOT"*) ;; *) exit 98 ;; esac
exec /bin/bash -c "$4"
`,
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    ARMADA_NATIVE_TEST_ROOT: home,
  };
}

/** The protocol bridge is portable; VM installer locking/atomic rename are Linux-only and
 * tested at their own boundary. macOS runs the real generated command in an owned fixture. */
async function installProtocolWrapper(path: string, install: (script: string) => Promise<void>) {
  if (process.platform === "linux") return install(nativeCwdInstallScript(path, nativeCwdCommand(path, "codex")));
  const original = `${path}.armada-original`;
  try {
    await lstat(original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rename(path, original);
  }
  await rm(path, { force: true });
  await writeFile(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
}

// Distinct bridge ownership: consume ONLY its own reload acknowledgement, preserve
// unrelated responses/notifications and fail one request closed without killing peers.
test("Codex reload control is private, preserves unmanaged params, and rejects unsafe config without killing the app-server", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-codex-control-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const path = join(home, "codex"),
      native = join(home, "native");
    await writeFile(
      native,
      `#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    m=json.loads(line)
    if m.get("method")=="config/mcpServer/reload":
        print(json.dumps({"method":"proof/event","params":{"alive":True}}),flush=True)
        print(json.dumps({"id":m["id"],"result":{}}),flush=True)
    else:
        print(json.dumps({"id":m["id"],"result":m.get("params")}),flush=True)
`,
    );
    await chmod(native, 0o755);
    await symlink(native, path);
    const installScript = async (script: string, configuration?: McpBootstrap) => {
      const p = Bun.spawn(["bash"], {
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...(await installEnvironment(home)),
          ...(configuration ? { ARMADA_GIT_TOKEN: JSON.stringify(configuration) } : {}),
        },
      });
      expect(await p.exited).toBe(0);
      expect(await new Response(p.stderr).text()).toBe("");
    };
    const install = (configuration: McpBootstrap) => installScript(nativeMcpInstallScript, configuration);
    await installProtocolWrapper(path, installScript);
    await install({
      revision: "first",
      servers: {
        armada_remote: {
          type: "http",
          url: "https://gateway.example/mcp",
          headers: { Authorization: "first-private" },
        },
      },
    });
    const running = Bun.spawn([path, "app-server", "--listen", "stdio://"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    });
    child = running;
    const reader = running.stdout.getReader();
    let buffer = "";
    const line = async () => {
      while (!buffer.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw Error("Bridge unexpectedly exited");
        buffer += new TextDecoder().decode(next.value);
      }
      const i = buffer.indexOf("\n"),
        text = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      return JSON.parse(text);
    };
    const params = {
      threadId: "same-thread",
      cwd: "/unchanged",
      model: "runtime-model",
      config: {
        model_context_window: 1050000,
        "mcp_servers.armada_public.http_headers": { "X-Customer": "unchanged-public-header" },
        "mcp_servers.armada_remote_suffix.http_headers": { "X-Customer": "unchanged-similar-name" },
        "unrelated.mcp_servers.armada_remote": { value: "unchanged-unrelated-path" },
        mcp_servers: {
          own: { url: "https://customer.example/mcp", http_headers: { "X-Customer": "unchanged-customer-header" } },
        },
      },
    };
    const expected = params;
    running.stdin.write(`${JSON.stringify({ id: 1, method: "thread/start", params })}\n`);
    expect(await line()).toEqual({ id: 1, result: expected });
    await install({
      revision: "next",
      servers: {
        armada_remote: { type: "http", url: "https://gateway.example/mcp", headers: { Authorization: "next-private" } },
      },
    });
    running.stdin.write(`${JSON.stringify({ id: 2, method: "thread/resume", params })}\n`);
    expect(await line()).toEqual({ method: "proof/event", params: { alive: true } });
    expect(await line()).toEqual({ id: 2, result: expected }); // Internal control response never escapes.
    const ownedOverrides = [
      { mcp_servers: { armada_remote: { http_headers: { Authorization: "old-private" } } } },
      { "mcp_servers.armada_remote": { http_headers: { Authorization: "old-private" } } },
      { "mcp_servers.armada_remote.http_headers": { Authorization: "old-private" } },
      { "mcp_servers.armada_remote.http_headers.Authorization": "old-private" },
      { "mcp_servers.armada_remote.enabled": false },
      { mcp_servers: null },
    ];
    for (const [index, config] of ownedOverrides.entries()) {
      const id = 20 + index;
      const method = ["thread/start", "thread/resume", "turn/start"][index % 3];
      running.stdin.write(`${JSON.stringify({ id, method, params: { ...params, config } })}\n`);
      expect(await line()).toEqual({
        id,
        error: {
          code: -32602,
          message:
            "Inline managed MCP configuration is unsupported; start a new native session with disk-inherited MCP configuration.",
        },
      });
    }
    // The same child still admits the unchanged customer config after all refusals.
    running.stdin.write(`${JSON.stringify({ id: 30, method: "thread/resume", params })}\n`);
    expect(await line()).toEqual({ id: 30, result: expected });
    await rm(join(home, ".codex/config.toml"));
    await symlink(join(home, ".claude.json"), join(home, ".codex/config.toml"));
    running.stdin.write(`${JSON.stringify({ id: 3, method: "turn/start", params })}\n`);
    expect(await line()).toMatchObject({ id: 3, error: { code: -32603 } });
    running.stdin.write(`${JSON.stringify({ id: 4, method: "thread/read", params: { threadId: "peer-thread" } })}\n`);
    expect(await line()).toEqual({ id: 4, result: { threadId: "peer-thread" } });
    running.stdin.end();
    expect(await running.exited).toBe(0);
    expect(await new Response(running.stderr).text()).toBe("");
  } finally {
    child?.kill();
    await rm(home, { recursive: true, force: true });
  }
});

// Real pinned app-server protocol, offline inference: no model/auth credentials.
test.skipIf(!process.env.CODEX_NATIVE_TEST_BINARY)(
  "real Codex SAME process and thread resumes with rotated MCP credentials without model inference",
  async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const home = await mkdtemp(join(tmpdir(), "armada-real-codex-mcp-"));
    const servers: InstanceType<typeof McpServer>[] = [];
    let expected = "first",
      calls = 0,
      rejected = 0,
      rejectedStale = false;
    const sessions = new Map<
      string,
      { transport: InstanceType<typeof WebStandardStreamableHTTPServerTransport>; epoch: string }
    >();
    let staleSessionUsed = false;
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const sessionId = request.headers.get("mcp-session-id");
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (request.headers.get("authorization") !== expected) {
          // Closing an old client after revocation is allowed to be refused; only
          // executable POST admission must never use stale authority.
          if (request.method === "POST") {
            rejected++;
            rejectedStale ||= request.headers.get("authorization") === "first";
          }
          return new Response(null, { status: 403 });
        }
        if (session && session.epoch !== expected) {
          staleSessionUsed = true;
          return new Response(null, { status: 403 });
        }
        if (session) return session.transport.handleRequest(request);
        if (sessionId) return new Response(null, { status: 404 });
        const server = new McpServer({ name: "actual-protocol-proof", version: "1" });
        server.registerTool("proof", {}, async () => {
          calls++;
          return { content: [{ type: "text", text: "nonce-proof" }] };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: () => crypto.randomUUID(),
          keepAliveMs: 0,
        });
        await server.connect(transport);
        servers.push(server);
        const response = await transport.handleRequest(request);
        if (transport.sessionId) sessions.set(transport.sessionId, { transport, epoch: expected });
        return response;
      },
    });
    try {
      const path = join(home, "codex");
      await symlink(resolve(process.env.CODEX_NATIVE_TEST_BINARY as string), path);
      const install = async (script: string, configuration?: McpBootstrap) => {
        const p = Bun.spawn(["bash"], {
          stdin: new Blob([script]),
          stdout: "ignore",
          stderr: "ignore",
          env: {
            ...(await installEnvironment(home)),
            ...(configuration ? { ARMADA_GIT_TOKEN: JSON.stringify(configuration) } : {}),
          },
        });
        expect(await p.exited).toBe(0);
      };
      await installProtocolWrapper(path, install);
      const script = `
import json, subprocess, sys, os
p=subprocess.Popen([sys.argv[1],"app-server","--listen","stdio://","-c",'model_provider="offline"',"-c",'model_providers.offline={name="offline",base_url="http://127.0.0.1:1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
completed=False
def rpc(id,method,params):
    global completed
    p.stdin.write((json.dumps(dict(id=id,method=method,params=params))+"\\n").encode());p.stdin.flush()
    while True:
        line=p.stdout.readline()
        if not line:raise RuntimeError("native process exited")
        m=json.loads(line)
        if m.get("method")=="turn/completed":completed=True
        if m.get("id")==id:
            if "error" in m:raise RuntimeError(method+":"+str(m["error"].get("code")))
            return m["result"]
try:
    rpc(1,"initialize",{"clientInfo":{"name":"armada-mcp-proof","version":"1"},"capabilities":{"experimentalApi":True}})
    p.stdin.write(b'{"method":"initialized"}\\n');p.stdin.flush()
    params={"cwd":sys.argv[2],"approvalPolicy":"never","sandbox":"danger-full-access"}
    thread=rpc(2,"thread/start",params)["thread"]["id"]
    # A real local failed turn creates the rollout required by thread/resume.
    # The synthetic provider points only at loopback port 1: no model API/auth.
    turn=rpc(7,"turn/start",{"threadId":thread,"input":[{"type":"text","text":"offline persistence"}]})
    try:
        rpc(9,"turn/interrupt",{"threadId":thread,"turnId":turn["turn"]["id"]})
    except RuntimeError as error:
        if str(error)!="turn/interrupt:-32600":raise
    state=rpc(8,"thread/read",{"threadId":thread,"includeTurns":False})
    assert state["thread"]["status"]["type"]!="active"

    def native_pids():
        todo=[p.pid];found=[]
        while todo:
            pid=todo.pop()
            try:
                with open("/proc/%d/task/%d/children"%(pid,pid)) as source:todo.extend(map(int,source.read().split()))
                if os.path.basename(os.readlink("/proc/%d/exe"%pid))=="codex":found.append(pid)
            except (OSError,ValueError):pass
        return sorted(found)
    peer=rpc(40,"thread/start",params)["thread"]["id"]
    assert peer!=thread
    original_pids=None
    for phase in range(4):
        if phase:
            sys.stdin.readline()
            if phase!=2:
                result=rpc(10,"thread/resume",{"threadId":thread})
                assert result["thread"]["id"]==thread
            else:
                resumed_turn=rpc(17,"turn/start",{"threadId":thread,"input":[{"type":"text","text":"offline future turn only"}]})
                try:
                    rpc(18,"turn/interrupt",{"threadId":thread,"turnId":resumed_turn["turn"]["id"]})
                except RuntimeError as error:
                    if str(error)!="turn/interrupt:-32600":raise
            disk=rpc(11,"config/read",{"includeLayers":False,"cwd":sys.argv[2]})
            if phase==1:assert disk["config"]["mcp_servers"]["armada_remote"]["http_headers"]["Authorization"]=="restored", "disk-current-header-not-seen"
        rpc(3+phase*10,"mcpServerStatus/list",{"threadId":thread,"serverName":"armada_remote"})
        if phase<3:
            result=rpc(4+phase*10,"mcpServer/tool/call",{"threadId":thread,"server":"armada_remote","tool":"proof","arguments":{}})
            assert "nonce-proof" in json.dumps(result)
            peer_result=rpc(44+phase*10,"mcpServer/tool/call",{"threadId":peer,"server":"armada_remote","tool":"proof","arguments":{}})
            assert "nonce-proof" in json.dumps(peer_result)
        else:
            try:
                rpc(34,"mcpServer/tool/call",{"threadId":thread,"server":"armada_remote","tool":"proof","arguments":{}})
                raise AssertionError("removed MCP still admitted")
            except RuntimeError as error:
                assert str(error) in ("mcpServer/tool/call:-32600","mcpServer/tool/call:-32603")
        loaded=rpc(41,"thread/loaded/list",{})["data"]
        assert thread in loaded and peer in loaded
        current_pids=native_pids()
        assert current_pids
        inspection=["python3",sys.argv[3],str(p.pid),"--expected-native-binary",os.path.realpath(sys.argv[1]+".armada-original")]
        receipt=json.loads(subprocess.check_output(inspection,text=True))
        assert receipt["inspectionComplete"] and receipt["nativeAppServerFound"]
        assert receipt["nativeExecutableMatchesInstalledBinary"]
        if phase==0:
            wrong=json.loads(subprocess.check_output(inspection[:-1]+["/usr/bin/python3"],text=True))
            assert wrong["inspectionComplete"] and wrong["nativeAppServerFound"]
            assert not wrong["nativeExecutableMatchesInstalledBinary"]
        if phase==3:
            assert receipt["nativeHasFreshReloadBridgeAncestor"]
            assert not receipt["nativeHasLegacyInjectionBridgeAncestor"]
            assert not receipt["nativeHasNestedBridges"]
        if original_pids is None:original_pids=current_pids
        else:assert current_pids==original_pids
        print("phase-ok",flush=True)
finally:
    p.terminate();p.wait(timeout=5)
`;
      const configure = async (phase: string) => {
        expected = phase;
        await install(nativeMcpInstallScript, {
          revision: phase,
          servers: {
            armada_remote: {
              type: "http",
              url: `http://127.0.0.1:${upstream.port}/mcp`,
              headers: { Authorization: expected },
            },
          },
        });
      };
      await configure("first");
      const p = Bun.spawn(
        ["python3", "-c", script, path, home, join(import.meta.dir, "../../../scripts/mcp/inspect-codex-wrapper.py")],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        },
      );
      try {
        const reader = p.stdout.getReader();
        let buffer = "";
        const line = async () => {
          while (!buffer.includes("\n")) {
            const next = await reader.read();
            if (next.done)
              throw Error(
                `Native proof exited: ${await new Response(p.stderr).text()}; upstreamRejectedStale=${rejectedStale}`,
              );
            buffer += new TextDecoder().decode(next.value);
          }
          const i = buffer.indexOf("\n"),
            value = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          return value;
        };
        expect(await line()).toBe("phase-ok");
        await configure("restored");
        p.stdin.write("resume\n");
        expect(await line()).toBe("phase-ok");
        await configure("turnonly");
        p.stdin.write("turnonly\n");
        expect(await line()).toBe("phase-ok");
        await install(nativeMcpInstallScript, { revision: "removed", servers: {} });
        p.stdin.write("removed\n");
        expect(await line()).toBe("phase-ok");
        expect(await p.exited).toBe(0);
        expect(await new Response(p.stderr).text()).toBe("");
      } finally {
        p.kill();
      }
      expect(calls).toBe(6);
      expect(rejected).toBe(0);
      expect(staleSessionUsed).toBe(false);
      expect(sessions.size).toBeGreaterThanOrEqual(3);
    } finally {
      upstream.stop(true);
      await Promise.all(servers.map((s) => s.close()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
