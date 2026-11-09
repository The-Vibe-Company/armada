import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type McpBootstrap,
  nativeMcpInstallScript,
  nativeMcpScrubScript,
  normalizeNativeMcpBootstrap,
} from "../src/mcp-native.ts";

test("native bootstrap preserves user settings, rotates both harnesses, and scrubs snapshot credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-mcp-native-"));
  const token = crypto.randomUUID();
  const install = async (config: McpBootstrap) => {
    const child = Bun.spawn(["bash"], {
      stdin: new Blob([nativeMcpInstallScript]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify(config) },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).not.toContain(token);
    expect(stderr).not.toContain(token);
  };
  try {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        mcpServers: { own: { command: "own" }, armada_public: { type: "http", url: "https://public.example/mcp" } },
      }),
    );
    await install({
      revision: "one",
      servers: {
        armada_remote: {
          type: "http",
          url: "https://gateway.example/mcp/id",
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    const codex = Bun.TOML.parse(await readFile(join(home, ".codex/config.toml"), "utf8")) as {
      mcp_servers: Record<string, { url: string; http_headers: Record<string, string> }>;
    };
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.own.command).toBe("own");
    expect(codex.mcp_servers.armada_remote?.http_headers.Authorization).toBe(`Bearer ${token}`);
    expect(claude.mcpServers.armada_remote.headers.Authorization).toBe(`Bearer ${token}`);
    expect((await stat(join(home, ".claude.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".codex/config.toml"))).mode & 0o777).toBe(0o600);
    const rotated = crypto.randomUUID();
    await install({
      revision: "two",
      servers: {
        armada_remote: {
          type: "http",
          url: "https://gateway.example/mcp/id",
          headers: { Authorization: `Bearer ${rotated}` },
        },
      },
    });
    expect(await readFile(join(home, ".claude.json"), "utf8")).not.toContain(token);
    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).not.toContain(token);
    await writeFile(join(home, ".claude.json.backup-one"), await readFile(join(home, ".claude.json"), "utf8"));
    const publicRepo = JSON.stringify({ mcpServers: { public: { type: "http", url: "https://public.example/mcp" } } });
    await writeFile(join(home, ".mcp.json"), publicRepo);
    expect((await readFile(join(home, ".armada/mcp-owned.json"), "utf8")).includes(rotated)).toBe(false);
    await install({ revision: "scrub", servers: {} });
    const backup = await readFile(join(home, ".claude.json.backup-one"), "utf8");
    expect(backup.includes(rotated)).toBe(false);
    expect(JSON.parse(backup).mcpServers.armada_public.url).toBe("https://public.example/mcp");
    expect(await readFile(join(home, ".mcp.json"), "utf8")).toBe(publicRepo);
    for (const file of [".claude.json", ".codex/config.toml"]) {
      const contents = await readFile(join(home, file), "utf8");
      expect(contents).not.toContain(rotated);
      expect(contents).not.toContain("armada_remote");
    }
    expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")).mcpServers.own.command).toBe("own");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native bootstrap refuses a symlink instead of writing credentials through it", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-mcp-native-"));
  try {
    const target = join(home, "repo-file");
    await writeFile(target, "untouched");
    await symlink(target, join(home, ".claude.json"));
    const child = Bun.spawn(["bash"], {
      stdin: new Blob([nativeMcpInstallScript]),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify({ revision: "one", servers: {} }) },
    });
    expect(await child.exited).not.toBe(0);
    expect(await readFile(target, "utf8")).toBe("untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native stdio pin policy refuses shells, package tags and ranges before either provider receives configuration", () => {
  const config = (command: string, args: string[]) => ({
    revision: "pin_policy",
    servers: { armada_local: { type: "stdio" as const, command, args } },
  });
  expect(() =>
    normalizeNativeMcpBootstrap(config("/usr/bin/npx", ["--yes", "@example/mcp@1.2.3", "/workspace"])),
  ).not.toThrow();
  expect(
    normalizeNativeMcpBootstrap(config("/usr/local/bin/uvx", ["mcp-server-example==1.2.3", "/workspace"])).servers
      .armada_local,
  ).toMatchObject({
    command: "/usr/local/bin/uvx",
    args: ["--from", "mcp-server-example==1.2.3", "--", "mcp-server-example", "/workspace"],
  });
  for (const [command, args] of [
    ["bash", ["-c", "anything"]],
    ["npx", ["--yes", "@example/mcp@latest"]],
    ["npx", ["--yes", "@example/mcp@^1.2.3"]],
    ["npx", ["--yes", "--package@1.2.3"]],
    ["node", ["repo/server.js"]],
  ] as [string, string[]][]) {
    expect(() => normalizeNativeMcpBootstrap(config(command, args))).toThrow();
  }
});

test("an untouched golden snapshot does not require Node or modify public native configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-public-golden-"));
  try {
    const publicConfig = JSON.stringify({
      mcpServers: { public: { type: "http", url: "https://public.example/mcp" } },
    });
    await writeFile(join(home, ".claude.json"), publicConfig);
    const child = Bun.spawn(["/bin/bash"], {
      stdin: new Blob([nativeMcpScrubScript]),
      stdout: "pipe",
      stderr: "pipe",
      env: { HOME: home, PATH: "/nonexistent" },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(publicConfig);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
