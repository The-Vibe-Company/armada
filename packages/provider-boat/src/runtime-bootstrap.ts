import type { Provider } from "@armada/core";
import { runtimeBootstrapScript, shellQuote, sshStdinCheckout } from "@armada/core/server";

/** Start-only transport. The caller must fence old work and issue a fresh ticket. */
export async function startBoatRuntime(
  provider: Provider,
  input: {
    sandboxId: string;
    signal?: AbortSignal | undefined;
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
      signal: input.signal,
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
  const nodeVersion = "22.22.2";
  return `set +x
umask 077
can_run_bootstrap() (
  unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY
  "$1" -e 'if (typeof fetch !== "function" || typeof AbortSignal.timeout !== "function") process.exit(1)' >/dev/null 2>&1
)
find_runtime_node() (
  unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY
  for candidate in "$(type -P node)" /usr/local/bin/node /usr/bin/node; do
    case "$candidate" in /*) ;; *) continue ;; esac
    if [ -x "$candidate" ] && can_run_bootstrap "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
)
fetch_runtime_node() (
  unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY
  export PATH=/usr/local/bin:/usr/bin:/bin
  case "$(uname -m)" in
    x86_64) arch=x64; digest=978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3 ;;
    aarch64|arm64) arch=arm64; digest=b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28 ;;
    *) exit 1 ;;
  esac
  dist="node-v${nodeVersion}-linux-$arch"
  cd -- "$node_tmp" || exit 1
  curl -q -fsS --proto '=https' --max-time 20 --max-filesize 67108864 -o node.tar.gz "https://nodejs.org/dist/v${nodeVersion}/$dist.tar.gz" &&
    printf '%s  node.tar.gz\\n' "$digest" | sha256sum -c - &&
    tar -xzOf node.tar.gz "$dist/bin/node" > node && chmod 700 node
)
if ! runtime_node=$(find_runtime_node); then
  node_tmp=$(unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; mktemp -d /tmp/armada-boat-node.XXXXXXXX) || exit 1
  trap 'unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; rm -rf -- "$node_tmp"' EXIT
  fetch_runtime_node >/dev/null 2>&1 || exit 1
  runtime_node="$node_tmp/node"
  can_run_bootstrap "$runtime_node" || exit 1
fi
printf '%s' "$ARMADA_GIT_TOKEN" | (unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; exec "$runtime_node" -e ${shellQuote(runtimeBootstrapScript(serverUrl, artifact, cacheDir))})
`;
}
