import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { installNativeCwdWrapper, nativeCwdCommand } from "../src/native-cwd.ts";

test("ordinary Claude needs no Python bridge and managed installation refuses a missing interpreter before mutation", async () => {
  const home = mkdtempSync(join(tmpdir(), "armada-claude-interpreter-"));
  const path = join(home, "claude");
  writeFileSync(`${path}.armada-original`, "#!/bin/sh\nprintf native-without-python", { mode: 0o755 });
  try {
    const ordinary = spawnSync("/bin/bash", ["-c", nativeCwdCommand(path, "claude")], {
      env: { HOME: home, PATH: "/nonexistent" },
      encoding: "utf8",
    });
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).toBe("native-without-python");
    await expect(
      installNativeCwdWrapper(
        async (request) => {
          const result = spawnSync("/bin/bash", ["-c", request.command], {
            env: { HOME: home, PATH: "/nonexistent" },
            encoding: "utf8",
          });
          expect(result.stderr).toContain("python3: command not found");
          if (result.status !== 0) throw Error("Interpreter unavailable; install refused");
        },
        "parent",
        "claude",
        undefined,
        true,
      ),
    ).rejects.toThrow("install refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The actual wrapper command against an independent native stream-json peer.
test("Claude refresh ACK gates turns, removes tools and preserves the process/session and internal MCP", async () => {
  const home = mkdtempSync(join(tmpdir(), "armada-claude-mcp-"));
  const path = join(home, "claude");
  mkdirSync(join(home, ".armada"), { mode: 0o700 });
  const configure = (names: string[]) => {
    writeFileSync(join(home, ".armada", "mcp-owned.json"), JSON.stringify(names), { mode: 0o600 });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          armada_orchestrator: { type: "http", url: "http://127.0.0.1:32100/mcp" },
          ...Object.fromEntries(names.map((name) => [name, { type: "http", url: "https://tools.invalid/mcp" }])),
        },
      }),
      { mode: 0o600 },
    );
  };
  writeFileSync(
    `${path}.armada-original`,
    `#!/usr/bin/python3
import json,os,sys
servers={}
disabled=set()
for line in sys.stdin:
    message=json.loads(line)
    if message.get("type")=="control_request" and message["request"]["subtype"].startswith("mcp_"):
        request=message["request"]
        if request["subtype"]=="mcp_toggle":
            if request["serverName"] not in servers:
                print(json.dumps({"type":"control_response","response":{"subtype":"error","request_id":message["request_id"],"error":"unknown server"}}),flush=True)
                continue
            if request["enabled"]: disabled.discard(request["serverName"])
            else: disabled.add(request["serverName"])
        elif request["subtype"]=="mcp_set_servers": servers=request["servers"]
        errors={"armada_rejected":"private upstream detail"} if "armada_rejected" in servers else {}
        print(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":message["request_id"],"response":{"errors":errors}}}),flush=True)
    elif message.get("type")=="user":
        print(json.dumps({"type":"assistant" if message["message"]["content"]=="hold" else "result","session_id":"same-session","pid":os.getpid(),"tools":sorted(set(servers)-disabled)}),flush=True)
    else: print(line.strip(),flush=True)
`,
  );
  chmodSync(`${path}.armada-original`, 0o755);
  configure(["armada_first"]);
  const start = () =>
    spawn("bash", ["-c", `${nativeCwdCommand(path, "claude", undefined, true)} --input-format stream-json`], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  let child = start();
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  let exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  let lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = async (content = "inspect tools") => {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { content } })}\n`);
    const result = await lines.next();
    expect(result.done).toBe(false);
    return JSON.parse(result.value!);
  };
  try {
    const first = await send();
    expect(first.tools).toEqual(["armada_first", "armada_orchestrator"]);
    expect((await send("hold")).type).toBe("assistant");
    const steered = await send("steer while running");
    expect(steered.type).toBe("result");
    expect(steered.pid).toBe(first.pid);
    expect(steered.session_id).toBe(first.session_id);
    configure(["armada_first", "armada_second"]);
    expect((await send()).tools).toEqual(["armada_first", "armada_orchestrator", "armada_second"]);
    configure(["armada_first"]);
    const removed = await send();
    expect(removed.tools).toEqual(["armada_first", "armada_orchestrator"]);
    expect(removed.pid).toBe(first.pid);
    expect(removed.session_id).toBe(first.session_id);
    configure(["armada_first", "armada_third"]);
    expect((await send()).tools).toEqual(["armada_first", "armada_orchestrator", "armada_third"]);
    configure(["armada_first", "armada_second"]);
    expect((await send()).tools).toEqual(["armada_first", "armada_orchestrator", "armada_second"]);
    configure([]);
    // The real native installer removes its ownership manifest for the empty set.
    rmSync(join(home, ".armada", "mcp-owned.json"));
    expect((await send()).tools).toEqual(["armada_orchestrator"]);
    configure(["armada_rejected"]);
    child.stdin.write(`${JSON.stringify({ type: "user", message: { content: "must not run" } })}\n`);
    expect(await exited).toBe(1);
    expect((await lines.next()).done).toBe(true);
    expect(error).toContain("no turn was submitted");
    expect(error).not.toContain("private upstream detail");
    configure(["armada_first"]);
    child = start();
    exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const alive = await send();
    child.kill("SIGTERM");
    await exited;
    expect(() => process.kill(alive.pid, 0)).toThrow();
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
