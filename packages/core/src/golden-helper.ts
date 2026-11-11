import manifest from "../helper/manifest.json";
import { GoldenError } from "./golden-config.ts";
import type { HelperReceipt } from "./helper.ts";
import type { Provider } from "./provider.ts";

/** Inert native ELF distribution bundled with this server release; no remote mutable installer. */
export const GOLDEN_HELPER_SETUP = String.raw`armada_phase=helper
(
  set -eu
  failure() { printf 'ARMADA_BUILD_FAILURE helper 98\n' >&2; exit 98; }
  case "$(uname -m)" in
    x86_64) hash=${manifest.x86_64.digest}; data='${manifest.x86_64.base64}' ;;
    aarch64|arm64) hash=${manifest.aarch64.digest}; data='${manifest.aarch64.base64}' ;;
    *) failure ;;
  esac
  dest=/home/user/.local/share/armada/helper/0.1.0
  for dir in /home/user/.local /home/user/.local/bin /home/user/.local/share /home/user/.local/share/armada /home/user/.local/share/armada/helper "$dest"; do
    [ ! -L "$dir" ] || failure
    mkdir -p "$dir" || failure
  done
  tmp=$(mktemp "$dest/.helper.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT
  printf '%s' "$data" | base64 -d > "$tmp" || failure
  printf '%s  %s\n' "$hash" "$tmp" | sha256sum --check --status || failure
  chmod 755 "$tmp" || failure
  [ "$("$tmp")" = '{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}' ] || failure
  mv -f -- "$tmp" "$dest/armada-helper" || failure
  ln -sfn "$dest/armada-helper" /home/user/.local/bin/armada-helper || failure
)`;

/** Read back bytes after all user init, before publication. No secret-bearing transport. */
export async function verifyGoldenHelper(
  provider: Provider,
  sandboxId: string,
): Promise<Omit<HelperReceipt, "snapshotId">> {
  const result = await provider.exec({
    sandboxId,
    cwd: "/home/user",
    timeoutSeconds: 30,
    command: `set -eu; p=/home/user/.local/share/armada/helper/0.1.0/armada-helper; arch=$(uname -m); case "$arch" in x86_64) hash=${manifest.x86_64.digest} ;; aarch64|arm64) hash=${manifest.aarch64.digest} ;; *) exit 98 ;; esac; printf '%s  %s\\n' "$hash" "$p" | sha256sum --check --status; printf '%s\\n' "$arch"; sha256sum "$p"; "$p"`,
  });
  if (result.detached) throw new GoldenError("setup_failed", "Helper verification must run in the foreground.");
  const [arch, hash, report] = result.stdout.trim().split("\n");
  const platform = arch === "arm64" ? "aarch64" : arch;
  if (
    result.detached ||
    result.truncated ||
    result.timedOut ||
    result.exitCode !== 0 ||
    (platform !== "x86_64" && platform !== "aarch64") ||
    hash !== `${manifest[platform].digest}  /home/user/.local/share/armada/helper/0.1.0/armada-helper` ||
    report !== '{"version":"0.1.0","protocol":1,"capabilities":["diagnose"]}'
  )
    throw new GoldenError("setup_failed", "Helper integrity verification failed; rebuild the golden.");
  return { version: "0.1.0", digest: manifest[platform].digest, platform, protocol: 1, capabilities: ["diagnose"] };
}
