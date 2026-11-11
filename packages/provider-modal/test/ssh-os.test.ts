import { expect, test } from "bun:test";
import type { Sandbox } from "modal";
import type { Provider } from "../../core/src/provider.ts";
import { sshPrivateSkillCommand } from "../../core/src/ssh-executor.ts";
import type { Machine } from "../src/ports.ts";
import { createSshPreparation } from "../src/ssh.ts";

// Real SSH, host pinning, SDK preparation and NNP; no Modal account or model/registry request.
// /run can be private to root on a provider VM. Public authorization must not depend on its traversal.
test.skipIf(!process.env.ARMADA_GOLDEN_OS_IMAGE).each([
  [false, 700],
  [false, 755],
  [true, 700],
] as const)(
  "Modal SSH authenticates the trusted role (golden=%s run=%s)",
  async (golden, runMode) => {
    const name = `armada-ssh-auth-${crypto.randomUUID()}`;
    const docker = (args: string[]) => Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    try {
      expect(
        docker([
          "run",
          "-d",
          "--rm",
          "--name",
          name,
          "-p",
          "127.0.0.1::2222",
          process.env.ARMADA_GOLDEN_OS_IMAGE!,
          "sleep",
          "infinity",
        ]).exitCode,
      ).toBe(0);
      expect(docker(["exec", name, "chmod", String(runMode), "/run"]).exitCode).toBe(0);
      const port = Number(docker(["port", name, "2222/tcp"]).stdout.toString().trim().split(":").at(-1));
      expect(port).toBeGreaterThan(0);
      const sdk = {
        exec: async (argv: string[]) => {
          const p = Bun.spawn(["docker", "exec", "-i", name, "setpriv", "--no-new-privs", ...argv], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
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
      // A second fresh key must work with the already-running daemon too.
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          (
            await sshPrivateSkillCommand(provider, {
              sandboxId: name,
              key: "",
              script: "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status && id -un",
            })
          ).trim(),
        ).toBe(golden ? "root" : "user");
      }
      const wrongRole = {
        sshKey: async (input: { sandboxId: string; key: string }) => ({
          ...(await provider.sshKey(input)),
          username: golden ? "user" : "root",
        }),
      } as unknown as Provider;
      await expect(
        sshPrivateSkillCommand(wrongRole, { sandboxId: name, key: "", script: "true" }),
      ).rejects.toMatchObject({ reason: "skillpack_ssh_authentication_failed" });
      expect(docker(["exec", name, "stat", "-c", "%a", "/run"]).stdout.toString().trim()).toBe(String(runMode));
      expect(
        docker(["exec", name, "stat", "-c", "%U:%a", "/run/armada-ssh/authorized_keys"]).stdout.toString().trim(),
      ).toBe("root:644");
      expect(
        docker(["exec", "--user", "user", name, "test", "!", "-w", "/run/armada-ssh/authorized_keys"]).exitCode,
      ).toBe(0);
    } finally {
      docker(["rm", "-f", name]);
    }
  },
  60_000,
);
