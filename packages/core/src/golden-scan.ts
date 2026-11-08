import { GoldenError } from "./golden-config.ts";
import type { Provider } from "./provider.ts";

/**
 * GitHub's real token shapes: a one- or two-letter type prefix, an underscore, then a long run of
 * base62 characters with no separators (classic PATs `ghp_`, OAuth `gho_`, GitHub App
 * user-to-server `ghu_`, installation `ghs_` and refresh `ghr_` tokens are all `gh[a-z]_` plus 36+
 * such characters; fine-grained PATs are `github_pat_<22 chars>_<59+ chars>`). A short,
 * underscore-separated placeholder such as a test fixture (`ghs_test_secret`,
 * `ghu_caller_access_token`) does not match this: that is deliberate, so a repository that merely
 * mentions a token's shape (this file's own tests, for instance) is not itself flagged.
 */
export const GITHUB_TOKEN_PATTERN = "gh[oprsu]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9]{20,}_[A-Za-z0-9]{36,}";

/** More thorough than a quick in-session check: reading every git object can take a while. */
const TIMEOUT_SECONDS = 900;

/** Where a token could land: the repos' working trees, root's home (some tooling runs as root) and /tmp. */
const SCAN_ROOTS = "/home/user /root /tmp";

/**
 * The fail-closed check before a golden builder may be snapshotted: no GitHub token anywhere on
 * its disk. Three exit codes, none of which is a bare 0/1 a future caller could misread: `97` is a
 * token found, `95` is the scan itself failing to run (a permission or I/O error, or git refusing
 * to answer), and anything else (a crash) is also treated as a failure. A real error is never
 * confused with "nothing found": `grep` exits 1 for no match and 2+ for a real failure, and only
 * the latter stops the scan itself; `git`'s own exit code is always checked on its own, never
 * conflated with grep's by piping the two together. Only filenames and object shas are ever
 * inspected for *presence* of a match (`grep -l`/`-q`); the matched text itself is never printed,
 * logged, or returned.
 */
export async function scanGoldenSandbox(provider: Provider, sandboxId: string): Promise<void> {
  const script = [
    "set -u",
    `pattern='${GITHUB_TOKEN_PATTERN}'`,
    `roots='${SCAN_ROOTS}'`,
    // The working tree and dotfiles (shell history, credential caches) across every root. -a forces
    // grep to search binary files too, so a token baked into a compiled artifact is not skipped.
    // .git is excluded here: its packed, compressed objects are unlikely to match plain text and are
    // covered far more thoroughly, uncompressed, by the object scan below.
    "for root in $roots; do",
    '  [ -d "$root" ] || continue',
    '  grep -rlaE --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$pattern" "$root" >/dev/null 2>/dev/null',
    "  status=$?",
    '  if [ "$status" -eq 0 ]; then exit 97; fi',
    '  if [ "$status" -gt 1 ]; then exit 95; fi',
    "done",
    // Git history, reachable and unreachable, is enumerated directly. Each object is streamed
    // through grep; no expanded plaintext object is ever written to a temporary file.
    "for gitdir in $(find $roots -maxdepth 8 -type d -name .git 2>/dev/null); do",
    '  repo=$(dirname "$gitdir")',
    '  while IFS=" " read -r sha kind; do',
    '    case "$kind" in blob|tree|commit|tag) ;; *) exit 95 ;; esac',
    '    git -C "$repo" cat-file -p "$sha" | grep -aEq "$pattern"',
    '    statuses=("${PIPESTATUS[@]}")',
    '    [ "${statuses[0]}" -eq 0 ] || exit 95',
    '    [ "${statuses[1]}" -eq 0 ] && exit 97',
    '    [ "${statuses[1]}" -eq 1 ] || exit 95',
    '  done < <(git -C "$repo" cat-file --batch-all-objects --batch-check="%(objectname) %(objecttype)")',
    '  [ "${PIPESTATUS[0]:-0}" -eq 0 ] || exit 95',
    "done",
    "exit 0",
  ].join("\n");
  const result = await provider.exec({
    sandboxId,
    command: script,
    cwd: "/home/user",
    timeoutSeconds: TIMEOUT_SECONDS,
  });
  if (result.detached) throw new GoldenError("setup_failed", "The secret scan started in the background.");
  if (result.timedOut) throw new GoldenError("setup_failed", "The secret scan timed out.");
  if (result.exitCode === 97) {
    throw new GoldenError(
      "setup_failed",
      "The golden builder still has token-shaped material on disk; the golden was not saved.",
    );
  }
  if (result.exitCode !== 0) {
    throw new GoldenError("setup_failed", "The secret scan could not run to completion; the golden was not saved.");
  }
}
