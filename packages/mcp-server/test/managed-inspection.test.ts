import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHeaderSentinel, managedInspection } from "../../../scripts/mcp/managed-inspection.ts";

// This owner exercises the managed Linux VM's actual /proc PID/argv contract, not a portable process mock.
test.skipIf(process.platform !== "linux")(
  "native argv sentinel inspection excludes its exec command and ancestors, but catches an actual native-looking child leak",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "armada-native-argv-inspection-"));
    let native: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      await mkdir(join(home, ".codex"));
      const probe = {
        name: "argv_probe_fixture",
        url: "https://public.example/mcp",
        value: `harmless_argv_sentinel_${crypto.randomUUID()}`,
      };
      const id = crypto.randomUUID(),
        name = `armada_${id.replaceAll("-", "_")}`;
      const gateway = `armada_gw_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
      await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            [name]: {
              type: "http",
              url: `https://gateway.example/mcp/gateway/${id}`,
              headers: { Authorization: `Bearer ${gateway}` },
            },
          },
        }),
      );
      await writeFile(
        join(home, ".codex/config.toml"),
        `# BEGIN ARMADA MANAGED MCP\n[mcp_servers.${JSON.stringify(name)}]\nurl = "https://gateway.example/mcp/gateway/${id}"\n# END ARMADA MANAGED MCP\n`,
      );
      const wrapper = join(home, "probe-wrapper/node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
      await mkdir(join(wrapper, ".."), { recursive: true });
      await writeFile(
        wrapper,
        "const c=require('node:child_process').spawnSync('/bin/bash',['-c',process.argv[2]],{stdio:'inherit'});process.exit(c.status??1);\n",
      );
      const run = async (program: string) => {
        // The exec shell's ACTUAL argv contains the harmless sentinel; it is never evidence of a leak.
        const child = Bun.spawn(["node", wrapper, program], {
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(stdout.includes(probe.value)).toBe(false);
        expect(stdout.includes(gateway)).toBe(false);
        return JSON.parse(stdout) as {
          configured: boolean;
          sentinelConfigured: boolean;
          sentinelInNativeArgv: boolean;
          nativeChildObserved: boolean;
        };
      };
      expect((await run(installHeaderSentinel(probe))) as unknown).toMatchObject({ installed: true });
      const clean = await run(managedInspection([id], probe));
      expect(clean.configured).toBe(true);
      expect(clean.sentinelConfigured).toBe(true);
      expect(clean.sentinelInNativeArgv).toBe(false);
      for (const fixture of ["claude", "node_modules/@anthropic-ai/claude-agent-sdk/cli.js"]) {
        const fakeNative = join(home, fixture);
        await mkdir(join(fakeNative, ".."), { recursive: true });
        // Kernel-argv fixtures only; no model/API/MCP success is simulated here.
        await writeFile(fakeNative, "process.stdout.write('READY\\n');setInterval(()=>{},1000);\n");
        const inline = JSON.stringify({
          mcpServers: { fixture: { type: "http", url: probe.url, headers: { "X-Armada-Argv-Sentinel": probe.value } } },
        });
        native = Bun.spawn(["node", fakeNative, "--mcp-config", inline], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        await native.stdout.getReader().read();
        const leaked = await run(managedInspection([id], probe));
        expect(leaked.nativeChildObserved).toBe(true);
        expect(leaked.sentinelInNativeArgv).toBe(true);
        native.kill();
        await native.exited;
        native = undefined;
      }
    } finally {
      native?.kill();
      await native?.exited;
      await rm(home, { recursive: true, force: true });
    }
  },
);
