import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GitHubRuntimeConfiguration, Provider } from "@armada/core/server";
import { configureBoatGitHub } from "../src/github-boat.ts";

// Existing CI-owned OS fixture, not a live Boat/Modal API, GitHub request or new worker VM.
test.skipIf(!process.env.ARMADA_GOLDEN_OS_IMAGE)(
  "actual pinned SSH GitHub bootstrap preserves newer revisions and keeps replies private",
  async () => {
    const image = process.env.ARMADA_GOLDEN_OS_IMAGE!;
    const name = `armada-github-os-${crypto.randomUUID()}`;
    const docker = (args: string[], input?: string) =>
      spawnSync("docker", args, { input, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    const exec = (user: string, args: string[], input?: string) =>
      docker(["exec", "-i", "--user", user, name, ...args], input);
    try {
      expect(docker(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::22", image]).status).toBe(0);
      expect(
        exec("0", ["timeout", "30", "sh", "-c", "until ssh-keyscan -T 1 localhost >/dev/null 2>&1; do :; done"]).status,
      ).toBe(0);
      const endpoint = docker(["port", name, "22/tcp"]).stdout.trim();
      const hostKey = exec("0", ["cat", "/etc/ssh/ssh_host_ed25519_key.pub"]).stdout.trim();
      const provider = {
        id: "boat",
        sshKey: async ({ key }: { key: string }) => {
          const installed = exec(
            "0",
            [
              "sh",
              "-c",
              "install -d -m 700 -o user -g user /home/user/.ssh; cat >> /home/user/.ssh/authorized_keys; chown user:user /home/user/.ssh/authorized_keys; chmod 600 /home/user/.ssh/authorized_keys",
            ],
            `${key}\n`,
          );
          if (installed.status !== 0) throw Error("Fixture key registration failed");
          return { sshEndpoint: endpoint, hostKey, username: "user" };
        },
      } as unknown as Provider;
      const boot = exec("0", ["cat", "/proc/sys/kernel/random/boot_id"]).stdout.trim();
      const old = `offline-${crypto.randomUUID()}`,
        current = `offline-${crypto.randomUUID()}`;
      const configuration: GitHubRuntimeConfiguration = {
        version: 1,
        revision: "1",
        generation: boot,
        url: "https://unreachable.invalid/api/internal/github/credentials",
        capability: `armada_gh_${"a".repeat(64)}`,
        retired: [old, current],
        expiresAt: Date.now() + 60000,
      };
      expect(await configureBoatGitHub(provider, "fixture", configuration)).toEqual({ acknowledged: true });
      expect(await configureBoatGitHub(provider, "fixture", { ...configuration, revision: "2" })).toEqual({
        acknowledged: true,
      });
      await expect(configureBoatGitHub(provider, "fixture", configuration)).rejects.toThrow(
        "GitHub private bootstrap failed.",
      );
      await expect(
        configureBoatGitHub(provider, "fixture", { ...configuration, revision: "3", generation: "wrong-physical" }),
      ).rejects.toThrow("GitHub private bootstrap failed.");
      expect(exec("0", ["cat", "/home/user/.armada/github-install-revision"]).stdout).toBe("2");
      const socket = `/home/user/.armada/github-${createHash("sha256").update(boot).digest("hex").slice(0, 16)}/redact.sock`;
      const probe = `import sys,json,http.client,socket
value=json.load(sys.stdin)
class Private(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect(value['socket'])
c=Private('private');c.request('POST','/redact',value['sample'].encode());r=c.getresponse();sys.stdout.write(r.read().decode())
`;
      expect(
        exec("user", ["python3", "-c", probe], JSON.stringify({ socket, sample: `${old} ${current}` })).stdout,
      ).toBe("*** ***");
      // Root-only credentials, no raw registry listing, no stale SSH key left behind.
      expect(exec("0", ["stat", "-c", "%u:%a", socket.replace("redact.sock", "credentials.sock")]).stdout.trim()).toBe(
        "0:600",
      );
      expect(exec("user", ["cat", "/home/user/.ssh/authorized_keys"]).stdout).toBe("");
    } finally {
      docker(["rm", "-f", name]);
    }
  },
  60000,
);
