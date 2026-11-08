import { GoldenError } from "./golden-config.ts";
import type { Provider } from "./provider.ts";

/** GitHub's token prefixes: installation (`ghs_`), user-to-server (`ghu_`) and OAuth (`gho_`). */
const TOKEN_PATTERN = "gh[suo]_[A-Za-z0-9_-]{20,255}";
const TIMEOUT_SECONDS = 300;

/**
 * The fail-closed check before a golden builder may be snapshotted: no GitHub token anywhere on its
 * disk, working tree or git history included. Only filenames are inspected (`grep -l`), never match
 * content, so a hit cannot leak the token into this error. A hit, a timeout or a background command
 * all stop the build the same way: no snapshot, no persisted golden.
 */
export async function scanGoldenSandbox(provider: Provider, sandboxId: string): Promise<void> {
  const script = [
    "set -eu",
    `pattern='${TOKEN_PATTERN}'`,
    "hit=0",
    // The working tree, dotfiles included (shell history, credential caches), never printing a match.
    'if grep -rIlE --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$pattern" /home/user >/dev/null 2>&1; then hit=1; fi',
    // Git history: a token committed by a setup script would survive in a decompressed object, not the working tree.
    "for gitdir in $(find /home/user -maxdepth 6 -type d -name .git 2>/dev/null); do",
    '  repo=$(dirname "$gitdir")',
    '  if git -C "$repo" log --all -p 2>/dev/null | grep -qE "$pattern"; then hit=1; fi',
    "done",
    '[ "$hit" = 0 ]',
  ].join("\n");
  const result = await provider.exec({
    sandboxId,
    command: script,
    cwd: "/home/user",
    timeoutSeconds: TIMEOUT_SECONDS,
  });
  if (result.detached) throw new GoldenError("setup_failed", "The secret scan started in the background.");
  if (result.timedOut) throw new GoldenError("setup_failed", "The secret scan timed out.");
  if (result.exitCode !== 0) {
    throw new GoldenError(
      "setup_failed",
      "The golden builder still has token-shaped material on disk; the golden was not saved.",
    );
  }
}
