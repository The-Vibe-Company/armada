import { spawn } from "node:child_process";
import type { Provider } from "./provider.ts";
import { type SshExecDeps, sshStdinCheckout } from "./ssh-executor.ts";
import { cleanupGuestKey } from "./ssh-key-cleanup.ts";

export interface PrivateOrchestratorSshReceipt {
  physicalGeneration: string;
  acknowledged: boolean;
  port?: number;
  epoch?: string;
  authorityInstalled?: boolean;
}
/** Only a bounded, fixed-shape NONSECRET receipt may cross stdout. The private payload
 * continues to use the existing pinned stdin SSH transport, never Provider.exec/argv.
 * Other stdout/stderr is discarded and must never become an exception/log cause. */
export async function sshOrchestratorReceipt(
  provider: Provider,
  input: { sandboxId: string; token: string; script: string },
  deps: SshExecDeps = {},
): Promise<PrivateOrchestratorSshReceipt> {
  let receipt: PrivateOrchestratorSshReceipt | undefined,
    bad = false,
    pending = "",
    total = 0;
  const run = deps.spawn ?? spawn;
  const wrapped: typeof spawn = ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    if (file !== "ssh") return run(file, args, options);
    const child = run(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > 8192) {
        bad = true;
        return;
      }
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^ARMADA_ORCHESTRATOR_RECEIPT ([A-Za-z0-9_-]{1,4096})$/.exec(line);
        if (!match) continue;
        try {
          const value = JSON.parse(
            Buffer.from(match[1] ?? "", "base64url").toString(),
          ) as PrivateOrchestratorSshReceipt;
          if (
            receipt ||
            !value ||
            Object.keys(value).some(
              (key) => !["physicalGeneration", "acknowledged", "port", "epoch", "authorityInstalled"].includes(key),
            ) ||
            typeof value.physicalGeneration !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(value.physicalGeneration) ||
            typeof value.acknowledged !== "boolean" ||
            (value.authorityInstalled !== undefined && typeof value.authorityInstalled !== "boolean") ||
            (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) ||
            (value.epoch !== undefined && !/^[0-9]{1,19}$/.test(value.epoch))
          ) {
            bad = true;
            continue;
          }
          receipt = value;
        } catch {
          bad = true;
        }
      }
    });
    return child;
  }) as typeof spawn;
  try {
    await sshStdinCheckout(provider, { ...input, script: cleanupGuestKey + input.script }, { ...deps, spawn: wrapped });
  } catch {
    throw Error("orchestrator_private_ssh_unavailable");
  }
  if (bad || !receipt) throw Error("orchestrator_private_ssh_unavailable");
  return receipt;
}
