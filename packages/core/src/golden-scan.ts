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

/**
 * Boat's synchronous command API accepts only 1–600 seconds (SDK CommandRequest).
 * Use its full budget; timeout still fails closed, never snapshots a partial scan.
 */
const TIMEOUT_SECONDS = 600;

/** Where a token could land: the repos' working trees, root's home (some tooling runs as root) and /tmp. */
const SCAN_ROOTS = "/home/user /root /tmp";

/**
 * The fail-closed check before a golden builder may be snapshotted: no GitHub token anywhere on
 * its disk. Three exit codes, none of which is a bare 0/1 a future caller could misread: `97` is a
 * token found, `95` is the scan itself failing to run (a permission or I/O error, or git refusing
 * to answer), and anything else (a crash) is also treated as a failure. A real error is never
 * confused with "nothing found": `grep` exits 1 for no match and 2+ for a real failure, and only
 * the latter stops the scan itself; `git`'s own exit code is always checked on its own (via
 * `PIPESTATUS` where `cat-file` is piped straight into `grep`, or a dedicated exit check where it
 * is not), never conflated with grep's. A root we were never granted any access to at
 * all (the ordinary case for `/root` under the sandbox's own unprivileged user) is skipped, not an
 * error: there is nothing a process with no access to a tree could have put there, or could have
 * hidden from this scan by chmod-ing one file inside a tree we *do* otherwise own. Only filenames
 * and object shas are ever inspected for *presence* of a match (`grep -l`/`-q`); the matched text
 * itself is never printed, logged, or returned.
 */
export async function scanGoldenSandbox(provider: Provider, sandboxId: string): Promise<void> {
  const script = [
    "set -u",
    `pattern='${GITHUB_TOKEN_PATTERN}'`,
    `roots='${SCAN_ROOTS}'`,
    // The working tree and dotfiles (shell history, credential caches, .git/config and its other
    // plain-text metadata: a credential helper or a remote URL can carry a token) across every
    // root. -a forces grep to search binary files too, so a token baked into a compiled artifact
    // is not skipped; .git's own packed objects are covered, decompressed, by the object scan
    // below, so scanning them again here only costs time, never correctness.
    //
    // Only `/home/user` is ours unconditionally; `/root` is included for a builder that happens to
    // run as root, but the ordinary case is a sandbox user with no access to it at all (not even to
    // list it) — grep then exits 2 for "permission denied" on the directory itself, which is not
    // the same as a hidden file inside a root we do own, and must not fail the scan closed: skip a
    // root outright when we cannot even read or search it, the same way a missing one is skipped.
    "for root in $roots; do",
    '  [ -d "$root" ] || continue',
    '  [ -r "$root" ] && [ -x "$root" ] || continue',
    // Paths can themselves leak a token; test NUL-separated names without ever printing one.
    '  find "$root" -print0 2>/dev/null | grep -zEa "$pattern" >/dev/null 2>/dev/null',
    "  path_status=$?",
    '  if [ "$path_status" -eq 0 ]; then exit 97; fi',
    '  if [ "$path_status" -gt 1 ]; then exit 95; fi',
    '  grep -rlaE --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$pattern" "$root" >/dev/null 2>/dev/null',
    "  status=$?",
    '  if [ "$status" -eq 0 ]; then exit 97; fi',
    '  if [ "$status" -gt 1 ]; then exit 95; fi',
    "done",
    // Git history, reachable and unreachable objects alike: a token committed, then amended or reset
    // away, still exists as a loose object until a `git gc` that this flow never runs. `--batch-all-
    // objects` lists every object in the database directly, not just what `git log` can reach from a
    // ref, written to its own temp file so the listing command's own exit code is checked on its own.
    // Blobs, commits and tags are all read as text (trees are skipped: they list other objects' hashes
    // and names, never file content); each is streamed straight from `cat-file -p` into `grep` over a
    // pipe, so no expanded plaintext object ever touches disk, and `PIPESTATUS` keeps git's exit code
    // and grep's distinct rather than conflating them into one combined status.
    "for gitdir in $(find $roots -maxdepth 8 -type d -name .git 2>/dev/null); do",
    '  repo=$(dirname "$gitdir")',
    "  objects_file=$(mktemp)",
    '  git -C "$repo" cat-file --batch-all-objects --batch-check="%(objectname) %(objecttype)" >"$objects_file" 2>/dev/null',
    "  list_status=$?",
    '  if [ "$list_status" -ne 0 ]; then rm -f "$objects_file"; exit 95; fi',
    '  while IFS=" " read -r sha kind; do',
    '    case "$kind" in',
    "      blob|commit|tag) ;;",
    "      tree) continue ;;",
    // git itself could not account for this object (reported as e.g. "missing" on a corrupted
    // database): a scan that cannot inspect every object cannot say the builder is clean.
    '      *) rm -f "$objects_file"; exit 95 ;;',
    "    esac",
    '    git -C "$repo" cat-file -p "$sha" | grep -aEq "$pattern"',
    '    statuses=("${PIPESTATUS[@]}")',
    '    if [ "${statuses[0]}" -ne 0 ]; then rm -f "$objects_file"; exit 95; fi',
    '    if [ "${statuses[1]}" -eq 0 ]; then rm -f "$objects_file"; exit 97; fi',
    '    if [ "${statuses[1]}" -gt 1 ]; then rm -f "$objects_file"; exit 95; fi',
    '  done <"$objects_file"',
    '  rm -f "$objects_file"',
    "done",
    "exit 0",
  ].join("\n");
  const result = await provider.exec({
    sandboxId,
    // Root-owned image files are part of the snapshot. Non-interactive sudo fails closed when
    // unavailable or unauthorized instead of prompting or silently omitting /root.
    command: `if [ "$(id -u)" -eq 0 ]; then exec bash -c ${shellQuote(script)}; else exec sudo -n bash -c ${shellQuote(script)}; fi`,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
