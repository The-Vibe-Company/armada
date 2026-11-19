import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@armada/core/server";
import { nativeCwdCommand, nativeCwdInstallScript } from "../src/native-cwd.ts";
import { admitNativeUsage, bindNativeUsage, collectNativeUsage } from "../src/native-usage.ts";

/** Exercise the production privilege boundary without elevating owned temporary fixtures. */
function installFixture(root: string, command: string) {
  const bin = join(root, "fixture-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "sudo"),
    `#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = -n ] && [ "$2" = bash ] && [ "$3" = -c ] || exit 97
case "$4" in *"$ARMADA_NATIVE_TEST_ROOT"*) ;; *) exit 98 ;; esac
exec /bin/bash -c "$4"
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ARMADA_NATIVE_TEST_ROOT: root,
    },
  });
  expect(result.stderr).toBe("");
  return result;
}

function install(path: string, harness: "codex" | "claude", cwd: string, root: string) {
  return installFixture(root, nativeCwdInstallScript(path, nativeCwdCommand(path, harness, cwd)));
}

/** Portable protocol fixture only: execute the production wrapper command without pretending
 * macOS has the VM's Linux flock/GNU rename installer semantics. Linux keeps the real installer. */
function installProtocolFixture(path: string, root: string, cwd?: string) {
  if (process.platform === "linux")
    return installFixture(root, nativeCwdInstallScript(path, nativeCwdCommand(path, "codex", cwd), cwd));
  const original = `${path}.armada-original`;
  if (!existsSync(original)) renameSync(path, original);
  if (cwd !== undefined) writeFileSync(`${path}.armada-cwd`, cwd);
  rmSync(path, { force: true });
  writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex", cwd)}\n`, { mode: 0o755 });
  return { status: 0 };
}

for (const harness of ["codex", "claude"] as const) {
  test.skipIf(process.platform !== "linux")(
    `installs the ${harness} VM wrapper and preserves dynamic argv without recursion`,
    () => {
      const base = mkdtempSync(join(tmpdir(), "armada-boat-native-cwd-"));
      try {
        const bin = join(base, "bin with ' quote");
        const cwd = join(base, "repo with ' quote $ and ` shell");
        const output = join(base, "output");
        mkdirSync(bin, { recursive: true });
        mkdirSync(cwd);
        // Checked-out repositories and inherited Python paths must not supply bridge imports.
        for (const module of ["base64", "json", "contextlib", "tomllib"])
          writeFileSync(join(cwd, `${module}.py`), "raise RuntimeError('repository Python module executed')\n");
        const path = join(bin, harness);
        const native = `${path}-native`;
        writeFileSync(
          native,
          `#!/bin/sh
printf '%s\\0' invocation "$PWD" >> ${JSON.stringify(output)}
for arg do printf '%s\\0' "$arg" >> ${JSON.stringify(output)}; done
exit 23
`,
        );
        chmodSync(native, 0o755);
        symlinkSync(native, path);
        expect(install(path, harness, base, base).status).toBe(0);
        expect(install(path, harness, cwd, base).status).toBe(0);
        expect(install(path, harness, cwd, base).status).toBe(0);

        // Boat supplies these only when it starts the installed native agent.
        const common = [
          "--model",
          "runtime-model",
          "--protocol",
          "stream",
          "",
          "a ' quote",
          "$(exit 99)",
          "line\nbreak",
        ];
        const overrides = ["-C", "/bad", "--cd", "/also-bad", "--cd=/third-bad"];
        const literal = ["--", "-C", "/literal", "--cd=/literal-too"];
        const runtimeArgs = [...common, ...overrides, ...literal];
        const run = (args: string[]) =>
          spawnSync(path, args, {
            encoding: "utf8",
            timeout: 5_000,
            cwd: base,
            env: {
              ...process.env,
              HOME: base,
              PATH: `${bin}:${process.env.PATH}`,
              PYTHONPATH: cwd,
              PYTHONHOME: join(cwd, "hostile-python-home"),
            },
          });
        expect(run(runtimeArgs).status).toBe(23);
        // A later invocation must not replay the earlier runtime arguments.
        expect(run(["--model=second-model", "--json", "-C"]).status).toBe(23);
        expect(readFileSync(output, "utf8").split("\0")).toEqual([
          "invocation",
          cwd,
          ...common,
          ...(harness === "claude" ? overrides : []),
          ...literal,
          "invocation",
          cwd,
          "--model=second-model",
          "--json",
          ...(harness === "claude" ? ["-C"] : []),
          "",
        ]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
}

test("Codex wrapper enforces Boat's thread/turn protocol cwd, not only process cwd", async () => {
  const { fakeBoat } = await import("./support.ts");
  // os.getcwd() reports the resolved path; macOS tmpdir() sits behind the /var symlink.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "armada-boat-protocol-")));
  try {
    const cwd = join(base, "repo B ' $ `");
    mkdirSync(cwd);
    for (const module of ["base64", "json", "contextlib", "tomllib"])
      writeFileSync(join(cwd, `${module}.py`), "raise RuntimeError('repository Python module executed')\n");
    const path = join(base, "codex");
    const native = join(base, "native");
    // Faithful Boat app-server boundary: an explicit RPC cwd overrides the executable's cwd.
    writeFileSync(
      native,
      `#!/usr/bin/python3 -I
import json, os, sys
print(json.dumps({"argv": sys.argv[1:], "processCwd": os.getcwd()}), flush=True)
for line in sys.stdin.buffer:
    try:
        msg = json.loads(line)
    except ValueError:
        sys.stdout.buffer.write(line); sys.stdout.buffer.flush(); continue
    if isinstance(msg, dict) and msg.get("method") == "initialize":
        print(json.dumps({"id":msg["id"], "result":{}}), flush=True)
        continue
    print(json.dumps(msg), flush=True)
print("native stderr", file=sys.stderr)
sys.exit(23)
`,
    );
    chmodSync(native, 0o755);
    symlinkSync(native, path);
    const boat = fakeBoat({
      body: { ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });
    await boat.provider.prepareNativeHarnessCwd?.({ sandboxId: "bx_test", harness: "codex", cwd });
    // Linux runs exactly the SDK-serialized VM installer with only the bin path relocated.
    // macOS owns only the generated protocol command; the Linux installer has its own tests.
    const body = boat.requests[0]?.body as { command: string };
    const command = body.command.replaceAll("/usr/local/bin/codex", path);
    expect(
      process.platform === "linux"
        ? installFixture(base, command).status
        : installProtocolFixture(path, base, cwd).status,
    ).toBe(0);
    // A default MCP refresh must retain the explicitly selected repository across reinstall.
    expect(installProtocolFixture(path, base).status).toBe(0);
    const unsupported = spawnSync(path, ["app-server", "--listen", "ws://127.0.0.1:9000"], {
      env: { HOME: base, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(unsupported.status).toBe(1);
    expect(unsupported.stdout).toBe("");
    expect(unsupported.stderr).toContain("requires Codex stdio transport");
    const messages = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "boat" } } },
      ...["thread/start", "thread/resume", "turn/start"].map((method, i) => ({
        id: i + 2,
        method,
        params: {
          cwd: base,
          model: "runtime-model",
          effort: "high",
          serviceTier: "priority",
          config: { model_context_window: 1050000 },
          threadId: "thread",
          input: [{ type: "text", text: "Go \n café" }],
        },
      })),
      { id: 8, result: { cwd: "/untouched", text: "reply to server tool call" } },
      { method: "initialized" },
      null,
    ];
    const args = ["app-server", "--listen", "stdio://", "--config", 'model="runtime-model"'];
    const result = spawnSync(path, args, {
      // Never inherit real subscription/GitHub configuration from the agent running this test.
      env: { HOME: base, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      input: `${messages.map((m) => JSON.stringify(m)).join("\n")}\nnot-json\n`,
      encoding: "utf8",
      cwd: base,
      timeout: 5000,
    });
    expect(result.status).toBe(23);
    expect(result.stderr).toBe("native stderr\n");
    const lines = result.stdout.trimEnd().split("\n");
    expect(JSON.parse(lines.shift() ?? "")).toEqual({ argv: args, processCwd: cwd });
    expect(lines.pop()).toBe("not-json");
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      messages.map((m) =>
        m && "params" in m
          ? m.method === "initialize"
            ? { id: m.id, result: {} }
            : { ...m, params: { ...m.params, cwd } }
          : m,
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "generic GitHub preparation preserves the managed Claude MCP bridge and rejects a tampered wrapper",
  () => {
    const home = mkdtempSync(join(tmpdir(), "armada-managed-claude-install-"));
    const path = join(home, "claude");
    const native = join(home, "native-claude");
    try {
      mkdirSync(join(home, ".armada"), { mode: 0o700 });
      writeFileSync(join(home, ".armada", "mcp-owned.json"), JSON.stringify(["armada_tools"]), { mode: 0o600 });
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { armada_tools: { type: "http", url: "https://tools.invalid/mcp" } } }),
        { mode: 0o600 },
      );
      writeFileSync(
        native,
        `#!/usr/bin/python3
import json,sys
managed=False
for line in sys.stdin:
    m=json.loads(line)
    if m.get("type")=="control_request":
        if m["request"]["subtype"]=="mcp_set_servers": managed=True
        print(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":m["request_id"],"response":{"errors":{}}}}),flush=True)
    elif m.get("type")=="user": print(json.dumps({"type":"result","managed":managed}),flush=True)
`,
        { mode: 0o755 },
      );
      symlinkSync(native, path);
      const managed = () =>
        installFixture(
          home,
          nativeCwdInstallScript(path, nativeCwdCommand(path, "claude", undefined, true), undefined, true),
        );
      const generic = () => installFixture(home, nativeCwdInstallScript(path, nativeCwdCommand(path, "claude")));
      expect(managed().status).toBe(0);
      expect(generic().status).toBe(0);
      const result = spawnSync(path, ["--input-format", "stream-json"], {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        input: JSON.stringify({ type: "user", message: { content: "tools" } }) + "\n",
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ type: "result", managed: true });
      writeFileSync(`${path}.armada-wrapper`, "#!/bin/sh\nexit 0\n");
      expect(generic().status).not.toBe(0);
      expect(managed().status).toBe(0);
      expect(generic().status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("Codex bridge refuses a second message until the first turn/start replies, then recovers", async () => {
  const base = mkdtempSync(join(tmpdir(), "armada-codex-start-"));
  const path = join(base, "codex");
  const native = join(base, "native");
  // A protocol barrier, not a timer: only release replies to the pending start.
  // Overlap models the native failure; the wrapper must prevent it reaching Codex.
  writeFileSync(
    native,
    `#!/usr/bin/python3
import json, sys
pending = None
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "turn/start":
        if pending is not None:
            sys.exit(99)
        pending = m["id"]
        print(json.dumps({"method":"test/starting"}), flush=True)
    elif m.get("method") == "release":
        print(json.dumps({"id":pending,"result":{"turn":{"id":"native-turn"}}}), flush=True)
        pending = None
    elif m.get("method") == "turn/steer":
        print(json.dumps({"id":m["id"],"result":{}}), flush=True)
`,
  );
  chmodSync(native, 0o755);
  symlinkSync(native, path);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    expect(installProtocolFixture(path, base).status).toBe(0);
    child = spawn(path, ["app-server"], {
      env: { HOME: base, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { createInterface } = await import("node:readline");
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const read = async () => {
      const next = await lines.next();
      expect(next.done).toBe(false);
      return JSON.parse(next.value!);
    };
    const send = (id: number, method: string) =>
      child!.stdin!.write(`${JSON.stringify({ id, method, params: { threadId: "thread", input: [] } })}\n`);
    send(1, "turn/start");
    expect(await read()).toEqual({ method: "test/starting" });
    for (const [id, method] of [
      [2, "turn/start"],
      [3, "turn/steer"],
    ] as const) {
      send(id, method);
      const reply = await read();
      expect(reply.id).toBe(id);
      expect(reply.error.message).toContain("turn_starting");
    }
    send(4, "release");
    expect(await read()).toEqual({ id: 1, result: { turn: { id: "native-turn" } } });
    send(5, "turn/steer");
    expect(await read()).toEqual({ id: 5, result: {} });
    send(6, "turn/start");
    expect(await read()).toEqual({ method: "test/starting" });
    send(7, "release");
    expect(await read()).toEqual({ id: 6, result: { turn: { id: "native-turn" } } });
    child.stdin!.end();
    const code = await new Promise<number | null>((resolve) => child!.once("exit", resolve));
    expect(code).toBe(0);
  } finally {
    child?.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test.each(["abort", "exit"] as const)(
  "Codex lone startup %s returns readable relaunch guidance on the pending RPC",
  async (failure) => {
    const base = mkdtempSync(join(tmpdir(), "armada-codex-boot-"));
    const path = join(base, "codex");
    const native = join(base, "native");
    try {
      writeFileSync(
        native,
        `#!/usr/bin/python3
import json, os, signal, sys
json.loads(sys.stdin.readline())
print("sanitized native boot diagnostic", file=sys.stderr, flush=True)
${failure === "abort" ? "os.kill(os.getpid(), signal.SIGABRT)" : "sys.exit(1)"}
`,
        { mode: 0o755 },
      );
      symlinkSync(native, path);
      expect(installProtocolFixture(path, base).status).toBe(0);
      const result = spawnSync(path, ["app-server"], {
        input: JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "boat" } } }) + "\n",
        encoding: "utf8",
        timeout: 5000,
        env: { HOME: base, PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        id: 1,
        error: {
          code: -32603,
          message: "The agent runtime could not start in this sandbox. Relaunch in a new sandbox.",
        },
      });
      expect(result.stderr).toContain("sanitized native boot diagnostic");
      expect(result.stderr).toContain("Relaunch in a new sandbox.");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("Codex boot abort before initialize still answers the later first request", async () => {
  const base = mkdtempSync(join(tmpdir(), "armada-codex-early-boot-"));
  const path = join(base, "codex");
  const native = join(base, "native");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(native, "#!/usr/bin/python3\nimport os, signal\nos.kill(os.getpid(), signal.SIGABRT)\n", {
      mode: 0o755,
    });
    symlinkSync(native, path);
    expect(installProtocolFixture(path, base).status).toBe(0);
    child = spawn(path, ["app-server"], {
      env: { HOME: base, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { createInterface } = await import("node:readline");
    const stderr = createInterface({ input: child.stderr! })[Symbol.asyncIterator]();
    const stdout = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    // This diagnosis is emitted only AFTER child.wait: no request can reach native.
    expect((await stderr.next()).value).toContain("The agent runtime could not start");
    child.stdin!.end(JSON.stringify({ id: "late-init", method: "initialize", params: {} }) + "\n");
    const reply = await stdout.next();
    expect(reply.done).toBe(false);
    expect(JSON.parse(reply.value!)).toEqual({
      id: "late-init",
      error: { code: -32603, message: "The agent runtime could not start in this sandbox. Relaunch in a new sandbox." },
    });
    const code = await new Promise<number | null>((resolve) => child!.once("exit", resolve));
    expect(code).toBe(1);
  } finally {
    child?.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

// Compatibility fixture derived from the installed Boat agent-server driver:
// skill items precede one text item, whose text has this exact user envelope.
// This is synthetic protocol data, not a captured transcript or a model turn.
test("Boat-framed Codex input reaches admitted native usage through the real bridge", async () => {
  const home = mkdtempSync(join(tmpdir(), "boat-framed-usage-"));
  const path = join(home, "codex");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const text = "Reply with the single word OK";
  try {
    writeFileSync(
      `${path}.armada-original`,
      `#!/usr/bin/python3 -I
import json,os,sys
session='12345678-1234-1234-1234-123456789012'
turn='native-turn'
for line in sys.stdin:
    m=json.loads(line);method=m.get('method')
    if method=='initialize': print(json.dumps({'id':m['id'],'result':{}}),flush=True)
    elif method=='thread/start': print(json.dumps({'id':m['id'],'result':{'thread':{'id':session}}}),flush=True)
    elif method=='turn/start':
        print(json.dumps({'method':'turn/started','params':{'threadId':session,'turn':{'id':turn}}}),flush=True)
        root=os.path.expanduser('~/.codex/sessions');os.makedirs(root)
        rows=[{'type':'session_meta','payload':{'id':session}},
          {'type':'event_msg','payload':{'type':'task_started','turn_id':turn}},
          {'type':'turn_context','payload':{'model':'gpt-6.1-sol'}},
          {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':42,'output_tokens':7,'cached_input_tokens':0,'cache_write_input_tokens':0,'reasoning_output_tokens':0}}}},
          {'type':'event_msg','payload':{'type':'task_complete','turn_id':turn}}]
        with open(root+'/rollout-'+session+'.jsonl','w') as f:
            for row in rows: f.write(json.dumps(row)+'\\n')
        print(json.dumps({'id':m['id'],'result':{'turn':{'id':turn}}}),flush=True)
        print(json.dumps({'method':'turn/completed','params':{'threadId':session,'turn':{'id':turn,'status':'completed'}}}),flush=True)
`,
      { mode: 0o700 },
    );
    writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex", home)}\n`, { mode: 0o700 });
    const provider = {
      exec: async (request: { command: string; onlyIfRunning?: boolean }) => {
        expect(request.onlyIfRunning).toBe(true);
        expect(request.command).not.toContain(text);
        const result = Bun.spawnSync(["/bin/sh", "-c", request.command], { env, cwd: home, timeout: 5000 });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          detached: false,
          timedOut: false,
          truncated: false,
        };
      },
    } as unknown as Provider;
    const ticket = await admitNativeUsage(provider, "sandbox", text);
    if (!ticket) throw new Error("Usage was not admitted");
    await bindNativeUsage(provider, "sandbox", ticket, "prompt");
    const input = [
      { type: "skill", name: "fixture", path: "/fixture/SKILL.md" },
      {
        type: "text",
        text: `<important-instructions-from-user>\n${text}</important-instructions-from-user>`,
        text_elements: [],
      },
    ];
    const driver = `import json,subprocess,sys
p=subprocess.Popen([sys.argv[1],'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def rpc(i,method,params):
    p.stdin.write(json.dumps({'id':i,'method':method,'params':params})+'\\n');p.stdin.flush()
    while True:
        line=p.stdout.readline()
        if not line: raise RuntimeError('fixture native exited')
        m=json.loads(line)
        if m.get('id')==i: return m['result']
try:
    rpc(1,'initialize',{})
    session=rpc(2,'thread/start',{})['thread']['id']
    rpc(3,'turn/start',{'threadId':session,'input':json.loads(sys.argv[2])})
    while True:
        line=p.stdout.readline()
        if not line: raise RuntimeError('fixture native exited before terminal')
        if json.loads(line).get('method')=='turn/completed': break
    p.stdin.close();assert p.wait(timeout=5)==0
finally:
    if p.poll() is None: p.kill()
`;
    const result = Bun.spawnSync(["python3", "-I", "-c", driver, path, JSON.stringify(input)], {
      env,
      cwd: home,
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    const rows = await collectNativeUsage(provider, "sandbox", "prompt");
    expect(rows).toEqual([
      {
        promptId: "prompt",
        model: "gpt-6.1-sol",
        inputTokens: 42,
        outputTokens: 7,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Boat external subscription bridge consumes refresh RPC privately and completes the same native turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "armada-boat-access-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const cert = join(home, "cert.pem"),
      key = join(home, "key.pem");
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    expect(generated.status).toBe(0);
    const revisions: unknown[] = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer private-guest-capability");
        const body = (await request.json()) as { previousRevision?: number };
        revisions.push(body.previousRevision ?? null);
        return Response.json({
          accessToken: body.previousRevision === 0 ? "private-next-access" : "private-first-access",
          chatgptAccountId: "shared-account",
          chatgptPlanType: null,
          revision: body.previousRevision === 0 ? 1 : 0,
        });
      },
    });
    mkdirSync(join(home, ".armada"), { mode: 0o700 });
    writeFileSync(
      join(home, ".armada/model-access.json"),
      JSON.stringify({ url: `https://localhost:${server.port}/access`, capability: "private-guest-capability" }),
      { mode: 0o600 },
    );
    const path = join(home, "codex");
    writeFileSync(
      `${path}.armada-original`,
      `#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='account/login/start':
  assert m['params']['type']=='chatgptAuthTokens' and m['params']['accessToken']=='private-first-access'
  print(json.dumps({'id':m['id'],'result':{'type':'chatgptAuthTokens'}}),flush=True)
 elif m.get('method')=='thread/start': print(json.dumps({'id':m['id'],'result':{'thread':{'id':'thread'}}}),flush=True)
 elif m.get('method')=='turn/start':
  print(json.dumps({'id':m['id'],'result':{'turn':{'id':'turn'}}}),flush=True)
  print(json.dumps({'id':'renew','method':'account/chatgptAuthTokens/refresh','params':{'reason':'unauthorized','previousAccountId':'shared-account'}}),flush=True)
 elif m.get('id')=='renew':
  assert m['result']['accessToken']=='private-next-access' and 'refreshToken' not in m['result']
  print(json.dumps({'method':'turn/completed','params':{'text':'renewed private-next-access private-guest-capability'}}),flush=True)
 else: print(json.dumps({'id':m.get('id'),'result':{}}),flush=True)
`,
      { mode: 0o755 },
    );
    writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
    child = Bun.spawn([path, "app-server"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", SSL_CERT_FILE: cert },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const pipe = child.stdin as import("bun").FileSink;
    pipe.write(
      '{"id":1,"method":"initialize","params":{}}\n{"id":2,"method":"thread/start","params":{}}\n{"id":3,"method":"turn/start","params":{"threadId":"thread"}}\n',
    );
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let output = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
      if (output.includes("turn/completed")) pipe.end();
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain('"text": "renewed *** ***"');
    expect(output).not.toContain("private-");
    expect(output).not.toContain("account/chatgptAuthTokens/refresh");
    expect(revisions).toEqual([null, 0]);
  } finally {
    child?.kill();
    server?.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

// Actual VM stdio bridge owns sanitizing native terminal errors before Boat sees them.
for (const source of ["updated", "read", "raced", "unauthorized", "unknown"])
  for (const validReset of source === "unauthorized" || source === "unknown" ? [true] : [true, false]) {
    test(`Boat plan exhaustion reaches a public outcome with only validated reset evidence (${source}, ${validReset})`, async () => {
      const home = mkdtempSync(join(tmpdir(), "boat-plan-limit-"));
      const path = join(home, "codex");
      try {
        writeFileSync(
          `${path}.armada-original`,
          `#!/usr/bin/python3 -I
import json,sys
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize': print(json.dumps({'id':m['id'],'result':{}}),flush=True)
 elif m.get('method')=='thread/start': print(json.dumps({'id':m['id'],'result':{'thread':{'id':'thread'}}}),flush=True)
 elif m.get('method')=='account/rateLimits/read':
  if '${source}'=='raced': print(json.dumps({'method':'account/rateLimits/updated','params':{'rateLimits':{'limitId':'codex','primary':{'usedPercent':100,'resetsAt':1794270000}}}}),flush=True)
  print(json.dumps({'id':m['id'],'result':{'rateLimits':{'limitId':'codex','primary':{'usedPercent':100,'resetsAt':${validReset ? "1794268800" : "'private-vendor-body'"}}}}}),flush=True)
 elif m.get('method')=='turn/start':
  if '${source}'=='updated': print(json.dumps({'method':'account/rateLimits/updated','params':{'rateLimits':{'limitId':'codex','primary':{'usedPercent':100,'resetsAt':${validReset ? "1794268800" : "'private-vendor-body'"}},'secondary':{'usedPercent':50,'resetsAt':1894268800}}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'thread','turn':{'id':'turn','status':'failed','error':{'message':${source === "unauthorized" || source === "unknown" ? "'Plan limit reached. Resets at 2026-11-10T00:00:00.000Z.'" : "'private-vendor-body'"},'codexErrorInfo':${source === "unauthorized" ? "'unauthorized'" : source === "unknown" ? "'other'" : "'usageLimitExceeded'"},'additionalDetails':'private-vendor-body'}}}}),flush=True)
`,
          { mode: 0o700 },
        );
        const input =
          [
            { id: 1, method: "initialize", params: {} },
            { id: 2, method: "thread/start", params: {} },
            ...(source !== "updated" ? [{ id: 4, method: "account/rateLimits/read", params: {} }] : []),
            { id: 3, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "hello" }] } },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n") + "\n";
        const result = spawnSync("/bin/bash", ["-c", nativeCwdCommand(path, "codex", home), "fixture", "app-server"], {
          cwd: home,
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          input,
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status).toBe(0);
        const rows = result.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const terminal = rows.find((row) => row.method === "turn/completed");
        expect(JSON.stringify(terminal)).not.toContain("private-vendor-body");
        const reason = terminal.params.turn.error.message;
        if (source === "unauthorized" || source === "unknown") {
          const expectedReason =
            source === "unauthorized"
              ? "Authentication failed. Reconnect this account."
              : "Plan limit reached. Resets at 2026-11-10T00:00:00.000Z.";
          expect(reason).toBe(expectedReason);
          expect(JSON.stringify(terminal)).not.toContain("private-vendor-body");
          const { normalizeEvent } = await import("../src/events.ts");
          const { promptOutcome } = await import("@armada/core");
          const event = normalizeEvent({
            id: "failed",
            timestamp: 1,
            type: "prompt",
            taskId: "p",
            data: { status: "failed", error: reason },
          });
          expect(
            await promptOutcome(
              { id: "boat" } as Provider,
              { sandboxId: "s", promptId: "p" },
              { state: { promptId: "p", status: "failed", done: true }, events: [event] },
            ),
          ).toMatchObject({
            state: "failed",
            reason: source === "unknown" ? expectedReason : expect.any(String),
          });
          return;
        }
        expect(JSON.stringify(terminal)).not.toContain("private-vendor-body");
        const resetsAt =
          source === "raced" ? "2026-11-10T00:20:00.000Z" : validReset ? "2026-11-10T00:00:00.000Z" : undefined;
        expect(reason).toBe(
          resetsAt
            ? `Plan limit reached. Resets at ${resetsAt}.`
            : "Plan limit reached. Try again after the limit resets.",
        );
        const { normalizeEvent } = await import("../src/events.ts");
        const { promptOutcome } = await import("@armada/core");
        const event = normalizeEvent({
          id: "failed",
          timestamp: 1,
          type: "prompt",
          taskId: "p",
          data: { status: "failed", error: reason },
        });
        const outcome = await promptOutcome(
          { id: "boat" } as Provider,
          { sandboxId: "s", promptId: "p" },
          { state: { promptId: "p", status: "failed", done: true }, events: [event] },
        );
        expect(outcome).toEqual({
          state: "failed",
          reason,
          limit: { code: "usage_limit_exceeded", ...(resetsAt ? { resetsAt } : {}) },
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
