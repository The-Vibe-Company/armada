import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GitHubRuntimeConfiguration, Provider } from "@armada/core/server";
import { configureBoatGitHub } from "../src/github-boat.ts";

async function waitForSsh(name: string) {
  const logs = Bun.spawn(["docker", "logs", "--follow", name], {
    stdout: "ignore",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  try {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of logs.stderr) {
      const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      if (lines.some((line) => line.startsWith("Server listening on "))) return;
    }
    throw new Error(`GitHub OS fixture ${name} did not report SSH readiness (docker logs exit ${await logs.exited}).`);
  } finally {
    logs.kill();
    await logs.exited;
  }
}

async function runProbe(image: string) {
  const name = `armada-github-os-${crypto.randomUUID()}`;
  const docker = (args: string[], input?: string) =>
    spawnSync("docker", args, { input, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  const exec = (user: string, args: string[], input?: string) =>
    docker(["exec", "-i", "--user", user, name, ...args], input);
  try {
    assert.equal(docker(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::22", image]).status, 0);
    await waitForSsh(name);
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
    assert.deepEqual(await configureBoatGitHub(provider, "fixture", configuration), { acknowledged: true });
    assert.deepEqual(await configureBoatGitHub(provider, "fixture", { ...configuration, revision: "2" }), {
      acknowledged: true,
    });
    await assert.rejects(configureBoatGitHub(provider, "fixture", configuration), /GitHub private bootstrap failed\./);
    await assert.rejects(
      configureBoatGitHub(provider, "fixture", { ...configuration, revision: "3", generation: "wrong-physical" }),
      /GitHub private bootstrap failed\./,
    );
    assert.equal(exec("0", ["cat", "/home/user/.armada/github-install-revision"]).stdout, "2");
    const socket = `/home/user/.armada/github-${createHash("sha256").update(boot).digest("hex").slice(0, 16)}/redact.sock`;
    const probe = `import sys,json,http.client,socket
value=json.load(sys.stdin)
class Private(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect(value['socket'])
c=Private('private');c.request('POST','/redact',value['sample'].encode());r=c.getresponse();sys.stdout.write(r.read().decode())
`;
    assert.equal(
      exec("user", ["python3", "-c", probe], JSON.stringify({ socket, sample: `${old} ${current}` })).stdout,
      "*** ***",
    );
    // Root-only credentials, no raw registry listing, no stale SSH key left behind.
    assert.equal(
      exec("0", ["stat", "-c", "%u:%a", socket.replace("redact.sock", "credentials.sock")]).stdout.trim(),
      "0:600",
    );
    const authorizedKeys = exec("user", ["cat", "/home/user/.ssh/authorized_keys"]);
    assert.equal(authorizedKeys.status, 0);
    assert.equal(authorizedKeys.stdout, "");
  } finally {
    docker(["rm", "-f", name]);
  }
}

const image = process.env.ARMADA_GOLDEN_OS_IMAGE;
if (!image) throw new Error("ARMADA_GOLDEN_OS_IMAGE is required");
await runProbe(image);
console.log("GitHub SSH bootstrap fixture passed.");
