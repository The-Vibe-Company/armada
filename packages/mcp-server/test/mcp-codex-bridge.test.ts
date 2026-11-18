import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type McpBootstrap, nativeMcpInstallScript } from "../src/mcp-native.ts";

import { installEnvironment, installProtocolWrapper } from "./mcp-codex-bridge-fixture.ts";

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
