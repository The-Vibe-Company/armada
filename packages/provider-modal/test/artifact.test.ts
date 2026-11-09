import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSetupCommand } from "@armada/core";
import {
  createGenerationGrants,
  createRunnerTransport,
  loadRunnerArtifact,
  type Machine,
  type Scope,
} from "../src/index.ts";

// Uses the real Linux-built runtime, native toolchain, setsid and /proc-backed private state.
// Portable bundle preparation on macOS does not install Linux-native resources. Linux CI builds
// and validates the full native artifact before running tests; missing native files there still fail.
const dist = join(import.meta.dir, "../../agent-runtime/dist");
const present = await Bun.file(join(dist, "manifest.json")).exists();
(process.platform === "linux" && present ? test : test.skip)(
  "actual runtime artifact accepts private bootstrap and scoped RPC, checkpoints and reopens journal",
  async () => {
    const artifact = await loadRunnerArtifact(dist);
    expect(artifact.bundle.length).toBeGreaterThan(1000);
    const root = await mkdtemp(join(tmpdir(), "armada-artifact-"));
    await Bun.write(join(root, "main.js"), artifact.bundle);
    for (const [name, version] of [
      ["claude", "2.1.319"],
      ["codex", "0.167.0"],
    ]) {
      const native = Bun.spawn([join(dist, name ?? ""), "--version"], {
        stdout: "pipe",
        stderr: "ignore",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          CODEX_HOME: join(root, "codex"),
          CLAUDE_CONFIG_DIR: join(root, "claude"),
        },
      });
      const [exit, output] = await Promise.all([native.exited, new Response(native.stdout).text()]);
      expect(exit).toBe(0);
      expect(output).toContain(version ?? "");
    }
    const scope: Scope = {
      orgId: "org",
      userId: "user",
      visibility: "private",
      binding: { workspace: "workspace", environment: "main", appId: "ap_bound" },
    };
    const row: Machine = {
      info: { id: "logical", name: "test", state: "ready", providerState: "active", labels: {} },
      phase: "active",
      generation: 1,
      grantExpiresAt: Date.now() + 60_000,
      golden: false,
      ttlSeconds: 60,
      physicalName: "physical",
    };
    const grants = createGenerationGrants(crypto.getRandomValues(new Uint8Array(32)), scope);
    let port = 0;
    // Start runtime with OS-assigned port reserved below, no model credentials, argv or bootstrap file.
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
    port = reserve.port ?? 0;
    await reserve.stop(true);
    let process: ReturnType<typeof Bun.spawn> | undefined;
    async function start() {
      const grant = grants.issue(row);
      process = Bun.spawn(["setsid", Bun.which("bun") ?? "bun", join(root, "main.js")], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root },
      });
      const input = process.stdin;
      if (typeof input === "number" || !input) throw Error("missing private pipe");
      input.write(
        JSON.stringify({
          root,
          cwd: root,
          port,
          grant,
          claudeExecutable: join(dist, "claude"),
          codexExecutable: join(dist, "codex"),
          claudeEnv: { ANTHROPIC_API_KEY: "synthetic-model-env-only" },
          codexEnv: {},
          credentialFreeBuilder: false,
          execEnv: {
            GH_TOKEN: "synthetic-artifact-github",
            GITHUB_TOKEN: "synthetic-artifact-github",
            HOME: root,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            GIT_CONFIG_GLOBAL: join(root, "fixture-gitconfig"),
            GIT_TERMINAL_PROMPT: "0",
          },
          ingestUrl: "http://127.0.0.1:1/unused",
        }),
      );
      input.end();
      const transport = createRunnerTransport(async () => ({
        url: `http://127.0.0.1:${port}`,
        connectToken: "proxy-fixture",
        grant: grant.token,
        expiresAt: grant.expiresAt,
      }));
      for (let attempt = 0; attempt < 1500; attempt++) {
        try {
          await transport.call(row, "health", {});
          return transport;
        } catch {
          await Bun.sleep(10);
        }
      }
      throw Error("actual runtime failed readiness");
    }
    try {
      let transport = await start();
      const denied = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
      const result = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
        input: { sandboxId: row.info.id, command: "printf actual-runtime" },
      });
      expect(result.stdout).toBe("actual-runtime");
      expect(result.exitCode).toBe(0);
      const environment = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
        input: {
          sandboxId: row.info.id,
          cwd: root,
          command: `printf '%s:%s:%s' "$GH_TOKEN" "$GITHUB_TOKEN" "\${ANTHROPIC_API_KEY-unset}"`,
        },
      });
      expect(environment.exitCode).toBe(0);
      expect(environment.stdout).toBe("[REDACTED]:[REDACTED]:unset");
      const helper = await transport.call<{ stdout: string; exitCode: number }>(row, "exec", {
        input: {
          sandboxId: row.info.id,
          cwd: root,
          command:
            gitSetupCommand({ id: 1, login: "fixture", name: "Fixture", email: "fixture@example.test" }) +
            `
credentials=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill)
case "$credentials" in *"password=$GH_TOKEN"*) printf helper-ok;; *) exit 1;; esac`,
        },
      });
      expect(helper.exitCode).toBe(0);
      expect(helper.stdout).toContain("helper-ok");
      expect(helper.stdout).not.toContain("synthetic-artifact-github");
      const configured = await transport.call<{ revision: string }>(row, "configureMcp", {
        configuration: { revision: "fixture-empty-config", servers: {} },
      });
      expect(configured).toEqual({ revision: "fixture-empty-config" });
      const checkpoint = await transport.call<{ generation: string; watermark: number; acknowledgedSequence: number }>(
        row,
        "checkpoint",
        {},
      );
      expect(checkpoint).toMatchObject({ generation: "1", watermark: 0, acknowledgedSequence: 0 });
      await expect(
        transport.call(row, "exec", { input: { sandboxId: row.info.id, command: "echo forbidden" } }),
      ).rejects.toMatchObject({ code: "sandbox_not_ready" });
      process?.kill();
      await process?.exited;
      row.generation = 2;
      transport = await start();
      expect(await transport.call(row, "health", {})).toMatchObject({ generation: "2", ready: true });
      const resumed = await transport.call<{ stdout: string }>(row, "exec", {
        input: { sandboxId: row.info.id, command: "printf restored" },
      });
      expect(resumed.stdout).toBe("restored");
    } finally {
      process?.kill();
      await process?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
