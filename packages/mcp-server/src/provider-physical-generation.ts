import type { Provider } from "@armada/core/server";

/** Fixed Boat boot-id fallback; null means no usable observation. Never probes another provider. */
export async function providerPhysicalGeneration(provider: Provider, sandboxId: string) {
  if (provider.id !== "boat") return null;
  const result = await provider.exec({ sandboxId, command: "cat /proc/sys/kernel/random/boot_id", timeoutSeconds: 30 });
  if (result.detached || result.timedOut || result.exitCode !== 0 || !/^[a-f0-9-]{36}$/i.test(result.stdout.trim()))
    return null;
  return result.stdout.trim();
}
