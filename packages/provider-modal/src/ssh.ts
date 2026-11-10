import { createPublicKey } from "node:crypto";
import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine, SshPreparation } from "./ports.ts";
import { quiesceSandboxProcesses } from "./process-scope.ts";

export const SSH_PORT = 2222;
/** Remove both daemon and established SSH sessions before saving any filesystem. */
export async function scrubSsh(sandbox: Sandbox, machine: Machine): Promise<void> {
  await quiesceSandboxProcesses(sandbox, machine);
  const process = await sandbox.exec(
    [
      "bash",
      "-c",
      `set -eu
rm -rf /run/armada-ssh
rm -f /etc/ssh/ssh_host_* /home/user/.ssh/authorized_keys /home/user/.ssh/authorized_keys2 /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
# Runtime owns auth scrubbing; fail closed if its checkpoint left a standard auth cache.
for file in /home/user/.armada-runtime/codex/auth.json /home/user/.armada-runtime/claude/.credentials.json /home/user/.codex/auth.json /home/user/.claude/.credentials.json /home/user/.config/gh/hosts.yml; do
  test ! -e "$file"
done
`,
    ],
    { timeoutMs: 30_000, env: {}, secrets: [] },
  );
  if ((await process.wait()) !== 0)
    throw refusal("conflict", "SSH could not be quiesced before snapshot.", "ssh_cleanup_failed");
}
export function createSshPreparation(): SshPreparation {
  return {
    async prepare(sandbox, machine, publicKey) {
      const username = machine.golden ? "root" : "user";
      // Only a single Ed25519 public key, never a shell expression or options supplied by the client.
      const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(publicKey.trim());
      if (!match || Buffer.from(match[1] ?? "", "base64").length !== 51)
        throw refusal("invalid_request", "An Ed25519 OpenSSH public key is required.");
      try {
        const decoded = Buffer.from(match[1] ?? "", "base64");
        if (
          decoded.readUInt32BE(0) !== 11 ||
          decoded.subarray(4, 15).toString() !== "ssh-ed25519" ||
          decoded.readUInt32BE(15) !== 32
        )
          throw Error();
        createPublicKey({
          key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decoded.subarray(19)]),
          format: "der",
          type: "spki",
        });
      } catch {
        throw refusal("invalid_request", "Invalid Ed25519 key.");
      }
      const process = await sandbox.exec(
        [
          "bash",
          "-c",
          `set -eu
umask 077
mkdir -p /run/sshd /run/armada-ssh
chmod 755 /run/armada-ssh
exec 9>/run/armada-ssh/lock
flock -x 9
read -r key
if ! test -f /run/armada-ssh/host; then ssh-keygen -q -t ed25519 -N '' -f /run/armada-ssh/host; fi
expiry=$(date -u -d '+15 minutes' +%Y%m%d%H%M%SZ)
printf 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,expiry-time="%s" %s\\n' "$expiry" "$key" >> /run/armada-ssh/authorized_keys
chmod 644 /run/armada-ssh/authorized_keys
cat > /run/armada-ssh/config <<'CONFIG'
Port 2222
ListenAddress 0.0.0.0
HostKey /run/armada-ssh/host
PidFile /run/armada-ssh/sshd.pid
AuthorizedKeysFile /run/armada-ssh/authorized_keys
AllowUsers ${username}
PermitRootLogin ${machine.golden ? "prohibit-password" : "no"}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
UsePAM no
PermitUserEnvironment no
AllowTcpForwarding no
X11Forwarding no
LogLevel QUIET
CONFIG
/usr/sbin/sshd -t -f /run/armada-ssh/config
if ! test -f /run/armada-ssh/sshd.pid || ! kill -0 "$(cat /run/armada-ssh/sshd.pid)" 2>/dev/null; then /usr/sbin/sshd -f /run/armada-ssh/config; fi
cat /run/armada-ssh/host.pub
`,
        ],
        { timeoutMs: 30_000, env: {}, secrets: [] },
      );
      await process.stdin.writeText(`ssh-ed25519 ${match[1]}\n`);
      await process.stdin.close();
      const [hostKey, exit] = await Promise.all([process.stdout.readText(), process.wait()]);
      if (exit !== 0 || !/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: .*)?\n?$/.test(hostKey))
        throw refusal("unavailable", "SSH provisioning failed.");
      const tunnel = (await sandbox.tunnels())[SSH_PORT];
      if (!tunnel) throw refusal("unavailable", "SSH tunnel is missing.");
      const [host, port] = tunnel.tcpSocket;
      return { endpoint: `${host}:${port}`, hostPublicKey: hostKey.trim(), username };
    },
  };
}
