import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Provider } from "../src/provider.ts";
import { sshPrivateSkillCommand } from "../src/ssh-executor.ts";

// Transport owns closed classifications; private CLI tests own receipt validation.
test.each([
  ["authorization", "skillpack_ssh_authorization_failed"],
  ["metadata", "skillpack_ssh_connection_invalid"],
  ["storage", "skillpack_ssh_local_storage_failed"],
  ["keygen", "skillpack_ssh_keygen_failed"],
  ["Host key verification failed", "skillpack_ssh_host_key_rejected"],
  ["Permission denied (publickey)", "skillpack_ssh_authentication_failed"],
  ["Connection refused", "skillpack_ssh_unreachable"],
  ["ARMADA_PRIVATE_FAILURE node_missing", "skillpack_ssh_node_missing"],
  ["ARMADA_PRIVATE_FAILURE flock_missing", "skillpack_ssh_flock_missing"],
  ["ARMADA_PRIVATE_FAILURE key_cleanup_failed", "skillpack_ssh_key_cleanup_failed"],
  ["unrecognized", "skillpack_ssh_remote_failed"],
])("private SSH classifies %s without forwarding diagnostics", async (scenario, reason) => {
  const opaque = "untrusted-private-detail";
  const provider = {
    sshKey: async () => {
      if (scenario === "authorization") throw Error(opaque);
      return { sshEndpoint: scenario === "metadata" ? "bad" : "ssh.test:22", hostKey: "ssh-ed25519 AAAA" };
    },
  } as unknown as Provider;
  const spawn: any = (file: string) => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = {
      end: () =>
        queueMicrotask(() => {
          if (file === "ssh") {
            p.stderr.emit("data", opaque + "\n" + scenario.slice(0, 8));
            p.stderr.emit("data", scenario.slice(8) + "\n");
          }
          p.emit("close", file === "ssh" || scenario === "keygen" ? 1 : 0);
        }),
    };
    return p;
  };
  const outcome = sshPrivateSkillCommand(
    provider,
    { sandboxId: "test", key: "synthetic", script: "unused" },
    {
      spawn,
      chmod: async () => {},
      readPublicKey: async () => "ssh-ed25519 AAAA",
      ...(scenario === "storage"
        ? {
            writeFile: async () => {
              throw Error(opaque);
            },
          }
        : {}),
    },
  );
  await expect(outcome).rejects.toMatchObject({ reason });
  await outcome.catch((error) => expect(String(error)).not.toContain(opaque));
});
