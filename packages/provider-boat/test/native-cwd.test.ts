import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
        m && "params" in m && m.method !== "initialize" ? { ...m, params: { ...m.params, cwd }, proof: cwd } : m,
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Offline real-protocol check: uses a temporary HOME and an allowlisted environment, never auth.
test.skipIf(!process.env.CODEX_NATIVE_TEST_BINARY)("real Codex app-server reports the selected thread cwd", () => {
  const base = mkdtempSync(join(tmpdir(), "armada-real-codex-"));
  try {
    const cwd = join(base, "repo-b");
    mkdirSync(cwd);
    const path = join(base, "codex");
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
import json, subprocess, sys
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
    print("real thread/start cwd verified")
finally:
    p.terminate(); p.wait(timeout=5)
`,
          executable,
          base,
          expected,
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
