import assert from "node:assert/strict";
import type { Sandbox } from "modal";
import type { Provider } from "../../core/src/provider.ts";
import { sshPrivateSkillCommand } from "../../core/src/ssh-executor.ts";
import type { Machine } from "../src/ports.ts";
import { createSshPreparation } from "../src/ssh.ts";

function docker(args: string[]) {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  assert.equal(result.exitCode, 0, `docker ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

async function checkSsh(image: string, golden: boolean, runMode: number) {
  const name = `armada-ssh-auth-${crypto.randomUUID()}`;
  docker(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::2222", image, "sleep", "infinity"]);
  try {
    docker(["exec", name, "chmod", String(runMode), "/run"]);
    const port = Number(docker(["port", name, "2222/tcp"]).split(":").at(-1));
    assert.ok(port > 0, "Docker must publish the SSH port");
    const sdk = {
      exec: async (argv: string[], { timeoutMs }: { timeoutMs: number }) => {
        const p = Bun.spawn(["docker", "exec", "-i", name, "setpriv", "--no-new-privs", ...argv], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          timeout: timeoutMs,
        });
        return {
          stdin: {
            writeText: async (text: string) => {
              p.stdin.write(text);
            },
            close: async () => {
              p.stdin.end();
            },
          },
          stdout: { readText: () => new Response(p.stdout).text() },
          wait: () => p.exited,
        };
      },
      tunnels: async () => ({ 2222: { tcpSocket: ["127.0.0.1", port] } }),
    } as unknown as Sandbox;
    const preparation = createSshPreparation();
    const provider = {
      sshKey: async ({ key }: { key: string }) => {
        const c = await preparation.prepare(sdk, { golden } as Machine, key);
        return { sshEndpoint: c.endpoint, hostKey: c.hostPublicKey, username: c.username };
      },
    } as unknown as Provider;
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(
        (
          await sshPrivateSkillCommand(provider, {
            sandboxId: name,
            key: "",
            script: "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status && id -un",
          })
        ).trim(),
        golden ? "root" : "user",
      );
    }
    const wrongRole = {
      sshKey: async (input: { sandboxId: string; key: string }) => ({
        ...(await provider.sshKey(input)),
        username: golden ? "user" : "root",
      }),
    } as unknown as Provider;
    await assert.rejects(sshPrivateSkillCommand(wrongRole, { sandboxId: name, key: "", script: "true" }), {
      reason: "skillpack_ssh_authentication_failed",
    });
    assert.equal(docker(["exec", name, "stat", "-c", "%a", "/run"]), String(runMode));
    assert.equal(docker(["exec", name, "stat", "-c", "%U:%a", "/run/armada-ssh/authorized_keys"]), "root:644");
    docker(["exec", "--user", "user", name, "test", "!", "-w", "/run/armada-ssh/authorized_keys"]);
  } finally {
    try {
      docker(["rm", "-f", name]);
    } catch (error) {
      console.error(`Docker cleanup failed for ${name}`, error);
      process.exitCode = 1;
    }
  }
}

const image = process.env.ARMADA_GOLDEN_OS_IMAGE;
if (!image) throw new Error("ARMADA_GOLDEN_OS_IMAGE is required");

for (const [golden, runMode] of [
  [false, 700],
  [false, 755],
  [true, 700],
] as const) {
  const label = `Modal SSH (golden=${golden}, run=${runMode})`;
  try {
    await checkSsh(image, golden, runMode);
    console.log(`${label}: passed`);
  } catch (error) {
    console.error(`${label}: failed`, error);
    process.exitCode = 1;
  }
}
