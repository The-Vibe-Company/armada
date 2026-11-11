import { expect, test } from "bun:test";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Provider, sshNativeAuthAdmission } from "@armada/core/server";
import { nativeCwdCommand, nativeCwdInstallScript } from "../src/native-cwd.ts";

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
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
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
  const base = mkdtempSync(join(tmpdir(), "armada-boat-protocol-"));
  try {
    const cwd = join(base, "repo B ' $ `");
    mkdirSync(cwd);
    const path = join(base, "codex");
    const native = join(base, "native");
    // Faithful Boat app-server boundary: an explicit RPC cwd overrides the executable's cwd.
    writeFileSync(
      native,
      `#!/usr/bin/python3
import json, os, subprocess, sys
print(json.dumps({"argv": sys.argv[1:]}), flush=True)
for line in sys.stdin.buffer:
    try:
        msg = json.loads(line)
    except ValueError:
        sys.stdout.buffer.write(line); sys.stdout.buffer.flush(); continue
    if isinstance(msg, dict) and msg.get("method") == "initialize":
        print(json.dumps({"id":msg["id"], "result":{}}), flush=True)
        continue
    if isinstance(msg, dict) and msg.get("method") in ("thread/start", "thread/resume", "turn/start"):
        msg["proof"] = subprocess.check_output(["pwd"], cwd=msg["params"]["cwd"], text=True).strip()
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
      input: `${messages.map((m) => JSON.stringify(m)).join("\n")}\nnot-json\n`,
      encoding: "utf8",
      cwd: base,
      timeout: 5000,
    });
    expect(result.status).toBe(23);
    expect(result.stderr).toBe("native stderr\n");
    const lines = result.stdout.trimEnd().split("\n");
    expect(JSON.parse(lines.shift() ?? "")).toEqual({ argv: args });
    expect(lines.pop()).toBe("not-json");
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      messages.map((m) =>
        m && "params" in m
          ? m.method === "initialize"
            ? { id: m.id, result: {} }
            : { ...m, params: { ...m.params, cwd }, proof: cwd }
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

// Offline real-protocol check: uses a temporary HOME and an allowlisted environment, never auth.
test.skipIf(!process.env.CODEX_NATIVE_TEST_BINARY)("real Codex app-server reports the selected thread cwd", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-real-codex-"));
  try {
    const cwd = join(base, "repo-b");
    mkdirSync(cwd);
    const path = join(base, "codex");
    mkdirSync(join(base, ".codex"), { mode: 0o700 });
    writeFileSync(join(base, ".codex/.armada-managed-native"), "active", { mode: 0o600 });
    symlinkSync(process.env.CODEX_NATIVE_TEST_BINARY as string, path);
    expect(installProtocolFixture(path, base, cwd).status).toBe(0);
    // Even with process cwd=repo-b, the unwrapped app-server accepts Boat's home cwd.
    for (const [executable, expected] of [
      [`${path}.armada-original`, base],
      [path, cwd],
    ] as const) {
      const proof = spawnSync(
        "python3",
        [
          "-c",
          `
import json, os, subprocess, sys
p = subprocess.Popen([sys.argv[1], "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
def request(id, method, params):
    p.stdin.write((json.dumps(dict(id=id, method=method, params=params)) + "\\n").encode()); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: raise RuntimeError("app-server exited")
        message = json.loads(line)
        if message.get("id") == id:
            if "error" in message: raise RuntimeError("RPC failed")
            return message["result"]
try:
    request(1, "initialize", {"clientInfo": {"name": "armada-cwd-test", "version": "1"}})
    p.stdin.write(b'{"method":"initialized"}\\n'); p.stdin.flush()
    result = request(2, "thread/start", {"cwd": sys.argv[2], "approvalPolicy": "never", "sandbox": "danger-full-access"})
    assert result["thread"]["cwd"] == sys.argv[3]
    if sys.argv[4] == "managed":
        with open(os.path.join(sys.argv[2], ".codex/.armada-native-writer.json")) as source:
            native = json.load(source)
        lock = os.stat(os.path.join(sys.argv[2], ".codex/.armada-native-writer.lock"))
        inherited = False
        for fd in os.listdir("/proc/" + str(native["pid"]) + "/fd"):
            try:
                info = os.stat("/proc/" + str(native["pid"]) + "/fd/" + fd)
                inherited = inherited or (info.st_dev,info.st_ino) == (lock.st_dev,lock.st_ino)
            except FileNotFoundError:
                pass
        assert inherited, "Pinned native Codex must retain the managed OS writer lock"
    print("real thread/start cwd verified")
finally:
    p.terminate(); p.wait(timeout=5)
`,
          executable,
          base,
          expected,
          executable === path ? "managed" : "direct",
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          cwd,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: base },
        },
      );
      expect(proof.stderr).toBe("");
      expect(proof.status).toBe(0);
      expect(proof.stdout).toBe("real thread/start cwd verified\n");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Real OS lock and native bridge process lifecycle, not a mock admission receipt.
test.skipIf(process.platform !== "linux")(
  "managed Boat native writers serialize, pause quiesces before capture, and resume keeps exec available",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "armada-native-writer-"));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const ownedGroups: { pid: number; start: string }[] = [];
    try {
      mkdirSync(join(root, ".codex"), { mode: 0o700 });
      const marker = join(root, ".codex/.armada-managed-native");
      writeFileSync(marker, "active", { mode: 0o600 });
      const path = join(root, "codex");
      writeFileSync(
        `${path}.armada-original`,
        `#!/usr/bin/python3
import json,os,sys,time
revision=0
old="unavailable"
for line in sys.stdin:
 message=json.loads(line)
 if message.get("method")=="private-rotate":
  revision+=1
  current="synthetic-native-refresh-"+str(revision)
  auth={"tokens":{"access_token":"synthetic-native-access-"+str(revision),"refresh_token":current,"account_id":"synthetic-native-account"}}
  fd=os.open(os.path.join(os.environ["HOME"],".codex/auth.json"),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
  with os.fdopen(fd,"w") as output: json.dump(auth,output)
  print(json.dumps({"id":message["id"],"result":{"old":old,"new":current}}),flush=True)
  old=current
 else: print(line.strip(),flush=True)
if os.environ.get("ARMADA_ORPHAN_PROOF"):
 while True: time.sleep(1)
`,
        { mode: 0o755 },
      );
      writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
      const start = (orphanProof = false) => {
        const child = Bun.spawn(["setsid", path, "app-server"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: root, PATH: "/usr/bin:/bin", ...(orphanProof ? { ARMADA_ORPHAN_PROOF: "1" } : {}) },
        });
        children.push(child);
        return child;
      };
      const first = start();
      first.stdin.write('{"id":1,"method":"ping"}\n');
      const firstReader = first.stdout.getReader();
      const answer = await firstReader.read();
      expect(JSON.parse(new TextDecoder().decode(answer.value))).toMatchObject({ id: 1 });
      for (const id of [8, 9]) {
        first.stdin.write(`${JSON.stringify({ id, method: "private-rotate" })}\n`);
        const reply = new TextDecoder().decode((await firstReader.read()).value);
        expect(reply).not.toContain("synthetic-native-refresh-");
        expect(JSON.parse(reply)).toMatchObject({ id, result: { new: "***" } });
        if (id === 9) expect(JSON.parse(reply)).toMatchObject({ result: { old: "***" } });
      }
      const second = start();
      second.stdin.write('{"id":99,"method":"ping"}\n');
      const admission = await Promise.race([
        second.exited.then(() => "refused"),
        second.stdout
          .getReader()
          .read()
          .then(async (read) => (read.done ? (await second.exited, "refused") : "admitted")),
      ]);
      expect(admission).toBe("refused");
      expect(second.exitCode).not.toBe(0);
      expect(await new Response(second.stderr).text()).toContain("native_auth_writer_busy");
      // A stopped/retrying publication cannot admit another writer until the
      // trusted server explicitly reopens this native account, without disabling shell exec.
      writeFileSync(marker, "paused");
      expect(await first.exited).not.toBe(0);
      expect(spawnSync("flock", ["-n", join(root, ".codex/.armada-native-writer.lock"), "true"]).status).toBe(0);
      const paused = start();
      expect(await paused.exited).not.toBe(0);
      expect(await new Response(paused.stderr).text()).toContain("native_auth_state_sync_pending");
      expect(spawnSync("bash", ["-c", "printf inspect"], { encoding: "utf8", cwd: root }).stdout).toBe("inspect");
      writeFileSync(marker, "active");
      const resumed = start();
      resumed.stdin.write('{"id":2,"method":"ping"}\n');
      resumed.stdin.end();
      const output = await new Response(resumed.stdout).text();
      expect(await new Response(resumed.stderr).text()).toBe("");
      expect(JSON.parse(output)).toMatchObject({ id: 2 });
      expect(await resumed.exited).toBe(0);
      const orphanBridge = start(true);
      orphanBridge.stdin.write('{"id":3,"method":"ping"}\n');
      await orphanBridge.stdout.getReader().read();
      ownedGroups.push(JSON.parse(readFileSync(join(root, ".codex/.armada-native-writer.json"), "utf8")));
      orphanBridge.kill("SIGKILL");
      await orphanBridge.exited;
      // The native process survives EOF, so only an inherited lock (not the dead
      // bridge's lock) can prevent a second refresh writer after this crash.
      const competing = start();
      competing.stdin.write('{"id":4,"method":"ping"}\n');
      const competed = await Promise.race([
        competing.exited.then(() => "refused"),
        competing.stdout
          .getReader()
          .read()
          .then(async (read) => (read.done ? (await competing.exited, "refused") : "admitted")),
      ]);
      expect(competed).toBe("refused");
      const preload = join(root, "private-fs.cjs");
      writeFileSync(
        preload,
        `const fs=require('node:fs');for(const name of ['lstatSync','statSync','openSync','readFileSync','writeFileSync']){const original=fs[name];fs[name]=function(p,...args){if(typeof p==='string'){for(const home of ['/home/user','/root'])if(p===home||p.startsWith(home+'/')){p=${JSON.stringify(root)}+p.slice(home.length);break;}}return original.call(fs,p,...args);}}`,
        { mode: 0o600 },
      );
      const privateSpawn = ((file: string, args: string[], options: SpawnOptions) => {
        if (file !== "ssh") return spawn(file, args, options);
        const destination = args.indexOf("user@private.test");
        return spawn("bash", ["-c", args.slice(destination + 1).join(" ")], {
          ...options,
          env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
        });
      }) as typeof spawn;
      const privateProvider: Pick<Provider, "id" | "sshKey"> = {
        id: "boat",
        sshKey: async () => ({ sshEndpoint: "private.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }),
      };
      // Execute the actual fixed-path pinned-SSH admission program against our
      // owned temporary home; it validates physical PID identity and inherited fd.
      await sshNativeAuthAdmission(privateProvider, "private-native", false, { spawn: privateSpawn });
      const captureLock = Bun.spawn(["flock", "-w", "5", join(root, ".codex/.armada-native-writer.lock"), "true"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await captureLock.exited).toBe(0);
      await sshNativeAuthAdmission(privateProvider, "private-native", true, { spawn: privateSpawn });
      const afterCrash = start();
      afterCrash.stdin.write('{"id":5,"method":"ping"}\n');
      afterCrash.stdin.end();
      expect(JSON.parse(await new Response(afterCrash.stdout).text())).toMatchObject({ id: 5 });
      expect(await afterCrash.exited).toBe(0);
    } finally {
      try {
        ownedGroups.push(JSON.parse(readFileSync(join(root, ".codex/.armada-native-writer.json"), "utf8")));
      } catch {}
      for (const group of ownedGroups) {
        try {
          const stat = readFileSync(`/proc/${group.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (
            fields[19] === group.start &&
            Number(fields[2]) === group.pid &&
            readFileSync(`/proc/${group.pid}/environ`, "utf8").split("\0").includes(`HOME=${root}`)
          )
            process.kill(-group.pid, "SIGKILL");
        } catch {}
      }
      for (const child of children) {
        try {
          child.kill();
        } catch {}
      }
      await Promise.all(children.map((child) => child.exited));
      rmSync(root, { recursive: true, force: true });
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
    child = spawn(path, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
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
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
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
