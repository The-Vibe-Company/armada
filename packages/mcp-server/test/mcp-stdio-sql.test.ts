import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlMcpRegistry, createSqlSandboxStore, type Provider } from "@armada/core/server";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createMcpLifecycle } from "../src/mcp-lifecycle.ts";
import { type McpBootstrap, nativeMcpInstallScript, normalizeNativeMcpBootstrap } from "../src/mcp-native.ts";

// Real registry admission -> binding -> backend normalization -> private native config consumer.
// The provider fixture supplies a VM filesystem, not an MCP health receipt. No package is run here.
test("registry-admitted pinned npx and uvx reach both native configs through fixed executable resolution", async () => {
  const db = await openDatabase(),
    home = await mkdtemp(join(tmpdir(), "armada-stdio-native-"));
  try {
    await applyMigrations(db);
    const user = crypto.randomUUID(),
      org = crypto.randomUUID(),
      golden = crypto.randomUUID(),
      id = crypto.randomUUID();
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.orgs(id,name) values($1,'Stdio fixture')", [org]);
    await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin')", [org, user]);
    await db.query(
      "insert into public.goldens(id,org_id,owner_id,name,visibility) values($1,$2,$3,'stdio','private')",
      [golden, org, user],
    );
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const registry = createSqlMcpRegistry(db, key);
    const npm = await registry.save(user, org, {
      name: "npm MCP",
      scope: "personal",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/mcp@1.2.3", "/workspace"],
      authType: "none",
    });
    const uv = await registry.save(user, org, {
      name: "uv MCP",
      scope: "personal",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-example==1.2.3", "--timezone", "UTC"],
      authType: "none",
    });
    expect(npm.status).toBe("connected");
    expect(uv.status).toBe("connected");
    for (const [command, args] of [
      ["npx", ["-y", "@example/mcp@latest"]],
      ["uvx", ["mcp-server-example>=1.2.3"]],
      ["bash", ["-c", "anything"]],
    ] as [string, string[]][]) {
      await expect(
        registry.save(user, org, {
          name: "bad",
          scope: "personal",
          transport: "stdio",
          command,
          args,
          authType: "none",
        }),
      ).rejects.toThrow();
    }
    const sandbox = await createSqlSandboxStore(db).insert({
      id,
      provider: "boat",
      providerSandboxId: "bx_stdio_fixture",
      goldenId: golden,
      orgId: org,
      ownerId: user,
      visibility: "private",
      harness: "codex",
      status: "ready",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
    const commands: string[] = [];
    const provider = {
      id: "boat",
      get: async () => ({
        id: "bx_stdio_fixture",
        state: "ready",
        physicalGeneration: "vm-stdio-1",
        expiresAt: new Date(Date.now() + 3600000),
      }),
      exec: async (request: { command: string }) => {
        commands.push(request.command);
        // Interpret the REAL production probe with an independent virtual-VM filesystem.
        // Fixed binaries exist in this image at /usr/bin/npx and /usr/local/bin/uvx.
        const filesystem = `function [() { if [[ "$#" == 3 && ( "$1" == -f || "$1" == -x ) && "$3" == ']' ]]; then case "$2" in /usr/bin/npx|/usr/local/bin/uvx) return 0;; *) return 1;; esac; fi; builtin [ "$@"; }\n`;
        const child = Bun.spawn(["/bin/bash"], {
          stdin: new Blob([filesystem, request.command]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        return { detached: false, exitCode, stdout, stderr, timedOut: false, truncated: false };
      },
      configureMcp: async ({ configuration }: { configuration: McpBootstrap }) => {
        const normalized = normalizeNativeMcpBootstrap(configuration);
        const child = Bun.spawn(["/bin/bash"], {
          stdin: new Blob([nativeMcpInstallScript]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: home, ARMADA_GIT_TOKEN: JSON.stringify(normalized) },
        });
        expect(await child.exited).toBe(0);
      },
    } as unknown as Provider;
    const lifecycle = createMcpLifecycle({ sql: db, registry, encryptionKey: key, origin: "https://gateway.example" });
    await lifecycle.connections.validate({ userId: user, orgId: org, role: "admin" }, [npm.id, uv.id], "private");
    await lifecycle.connections.bind(id, [npm.id, uv.id]);
    await lifecycle.connections.prepare?.(provider, sandbox, { userId: user, orgId: org, role: "admin" });
    const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const codex = Bun.TOML.parse(await readFile(join(home, ".codex/config.toml"), "utf8")) as {
      mcp_servers: Record<string, unknown>;
    };
    const npmName = `armada_${npm.id.replaceAll("-", "_")}`,
      uvName = `armada_${uv.id.replaceAll("-", "_")}`;
    for (const servers of [claude.mcpServers, codex.mcp_servers]) {
      expect(servers[npmName]).toMatchObject({
        command: "/usr/bin/npx",
        args: ["--yes", "--", "@example/mcp@1.2.3", "/workspace"],
      });
      expect(servers[uvName]).toMatchObject({
        command: "/usr/local/bin/uvx",
        args: ["--from", "mcp-server-example==1.2.3", "--", "mcp-server-example", "--timezone", "UTC"],
      });
    }
    expect(commands.some((command) => command.includes("@example/mcp") || command.includes("mcp-server-example"))).toBe(
      false,
    );
    expect(
      (
        await db.query<{ configured: boolean }>("select configured from public.mcp_bootstraps where sandbox_id=$1", [
          id,
        ])
      ).rows[0]?.configured,
    ).toBe(true);
  } finally {
    await db.close();
    await rm(home, { recursive: true, force: true });
  }
});
