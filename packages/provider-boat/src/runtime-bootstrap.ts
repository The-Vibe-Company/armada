import type { Provider } from "@armada/core";
import { runtimeBootstrapScript, shellQuote, sshStdinCheckout } from "@armada/core/server";

/** Start-only transport. The caller must fence old work and issue a fresh ticket. */
export async function startBoatRuntime(
  provider: Provider,
  input: {
    sandboxId: string;
    serverUrl: string;
    enrolmentToken: string;
    cacheDir: string;
    artifact: { sha256: string; bytes: number };
  },
): Promise<void> {
  if (provider.id !== "boat") throw Error("boat_runtime_required");
  const server = new URL(input.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.origin !== input.serverUrl.replace(/\/$/, "") ||
    !input.cacheDir.startsWith("/") ||
    input.cacheDir === "/" ||
    input.cacheDir.includes("\0") ||
    !/^[a-f0-9]{64}$/.test(input.artifact.sha256) ||
    !Number.isSafeInteger(input.artifact.bytes) ||
    input.artifact.bytes <= 0 ||
    input.artifact.bytes > 512 * 1024 * 1024 ||
    !/^armada_enrol_[a-f0-9]{64}$/.test(input.enrolmentToken)
  )
    throw Error("invalid_boat_runtime_bootstrap");
  try {
    await sshStdinCheckout(provider, {
      sandboxId: input.sandboxId,
      token: JSON.stringify({ serverUrl: server.origin, enrolmentToken: input.enrolmentToken }),
      script: boatRuntimeBootstrapScript(server.origin, input.artifact, input.cacheDir),
      timeoutMs: 150_000,
    });
  } catch {
    // Guest/transport failures must never surface private stdin or credentials.
    throw Error("boat_runtime_bootstrap_failed");
  }
}

/** Only public, validated artifact metadata is embedded in the remote command. */
export function boatRuntimeBootstrapScript(
  serverUrl: string,
  artifact: { sha256: string; bytes: number },
  cacheDir: string,
): string {
  return `set +x
umask 077
printf '%s' "$ARMADA_GIT_TOKEN" | node -e ${shellQuote(runtimeBootstrapScript(serverUrl, artifact, cacheDir))}
`;
}
